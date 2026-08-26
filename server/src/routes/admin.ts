/**
 * Owner console — read-only half (docs/ADMIN_CONSOLE.md §3, §6, build steps 1-3).
 *
 * ⚠️ **THE BOUNDARY, and it is the whole point of this file.** Hard invariant 1
 * says authorization = chat membership, and that is Den's entire privacy model.
 * This is the first authorization concept that isn't membership, so rather than
 * carve an exception:
 *
 *   > The owner is an OPERATOR, not a READER.
 *
 * Nothing in this file may join to `messages`, `media`, `embeds`, `chats` or
 * `chat_members`, and no response may carry message content, captions, tags or
 * who-talks-to-whom. The owner may see that an account exists, when it was last
 * seen, what credentials it has and what security events it produced — never
 * what anyone said. If a future admin feature seems to need chat content, that
 * is a signal to redesign the feature, not to widen this rule.
 *
 * Everything here is read-only. The state-changing half (unlock, revoke,
 * disable) is a deliberately separate change behind the §6 re-auth gate, so
 * the risky code lands as its own reviewable diff rather than a rider on this.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt, gte, sql } from 'drizzle-orm';
import {
  LoginThrottle,
  type AdminInvite,
  type AdminInvitesResponse,
  type AdminLocksResponse,
  type AdminPushHealthResponse,
  type AdminSessionsResponse,
  type AdminUsersResponse,
  type SecurityEvent,
  type SecurityEventsResponse,
} from '@den/shared';
import { db } from '../db/index.js';
import { inviteCodes, loginFailures, pushSubscriptions, sessions, users } from '../db/schema.js';
import { requireOwner } from '../auth/owner.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { checkLock } from '../auth/throttle.js';
import { listEvents } from '../admin/events.js';
import { env } from '../env.js';
import { validation } from '../errors.js';

const FEED_LIMIT = 50;

function parseBigint(raw: unknown, field: string): bigint | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  try {
    return BigInt(String(raw));
  } catch {
    throw validation(`${field} must be a numeric id`);
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Every route in this plugin is owner-only. Registered as a hook rather than
  // per-route so a new route cannot be added without the gate by forgetting it.
  app.addHook('preHandler', requireOwner);

  // ── security feed ───────────────────────────────────────────────────────
  app.get<{ Querystring: { before?: string; kind?: string; userId?: string } }>(
    '/admin/events',
    async (req) => {
      const rows = await listEvents({
        before: parseBigint(req.query.before, 'before'),
        kind: req.query.kind || undefined,
        userId: parseBigint(req.query.userId, 'userId'),
        limit: FEED_LIMIT + 1,
      });
      const page = rows.slice(0, FEED_LIMIT);
      const events: SecurityEvent[] = page.map((r) => ({
        id: r.id.toString(),
        kind: r.kind,
        userId: r.userId ? r.userId.toString() : null,
        username: r.username,
        actorUsername: r.actorUsername,
        ip: r.ip,
        userAgent: r.userAgent,
        data: r.data ?? {},
        createdAt: r.createdAt.toISOString(),
      }));
      const res: SecurityEventsResponse = {
        events,
        // Keyset, per the repo convention — the cursor is the last id we
        // actually returned, and null only when the page wasn't full.
        nextBefore: rows.length > FEED_LIMIT && page.length > 0 ? page[page.length - 1]!.id.toString() : null,
      };
      return res;
    },
  );

  // ── live locks ──────────────────────────────────────────────────────────
  //
  // Reads `login_failures` — the live counter, NOT the event history. These
  // answer different questions and the console needs both (§5).
  app.get('/admin/locks', async () => {
    const windowStart = new Date(Date.now() - LoginThrottle.windowMs);
    const grouped = await db
      .select({
        username: loginFailures.username,
        failures: sql<number>`count(*)::int`,
        lastFailureAt: sql<Date>`max(${loginFailures.createdAt})`,
      })
      .from(loginFailures)
      .where(gte(loginFailures.createdAt, windowStart))
      .groupBy(loginFailures.username)
      .orderBy(desc(sql`count(*)`));

    const locks = await Promise.all(
      grouped.map(async (g) => {
        const state = await checkLock(g.username);
        return {
          username: g.username,
          failures: g.failures,
          locked: state.locked,
          retryAfterSeconds: state.retryAfterSeconds,
          lastFailureAt: g.lastFailureAt ? new Date(g.lastFailureAt).toISOString() : null,
        };
      }),
    );
    const res: AdminLocksResponse = { locks };
    return res;
  });

  // ── users ───────────────────────────────────────────────────────────────
  //
  // ⚠️ Operator facts only. No message counts, no chat lists — see the header.
  app.get('/admin/users', async () => {
    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        createdAt: users.createdAt,
        isOwner: users.isOwner,
        disabledAt: users.disabledAt,
        // ⚠️ Written as literal, TABLE-QUALIFIED SQL rather than with drizzle
        // column interpolation, and that is not a style choice. Interpolating
        // `${users.id}` inside a `sql` template emits a BARE `"id"` with no
        // table prefix, so inside a correlated subquery it binds to the
        // SUBQUERY's table instead of `users` — `where "user_id" = "id"` was
        // silently comparing webauthn_credentials.user_id (bigint) against
        // webauthn_credentials.id (text) and the route 500'd with
        // `operator does not exist: bigint = text`. Aliases + explicit
        // qualification make the correlation unambiguous. Raw SQL kept visible
        // in its module, per CLAUDE.md.
        hasPassword: sql<boolean>`users.password_hash is not null`,
        passkeyCount: sql<number>`(select count(*)::int from webauthn_credentials wc where wc.user_id = users.id)`,
        vaultLinked: sql<boolean>`exists (select 1 from vault_links vl where vl.user_id = users.id)`,
        activeSessions: sql<number>`(select count(*)::int from sessions s where s.user_id = users.id and s.expires_at > now())`,
        pushSubscriptions: sql<number>`(select count(*)::int from push_subscriptions ps where ps.user_id = users.id)`,
        lastSeenAt: sql<Date | null>`(select max(s2.created_at) from sessions s2 where s2.user_id = users.id)`,
      })
      .from(users)
      .orderBy(users.username);

    const res: AdminUsersResponse = {
      users: rows.map((r) => ({
        id: r.id.toString(),
        username: r.username,
        displayName: r.displayName,
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt).toISOString() : null,
        isOwner: r.isOwner,
        disabledAt: r.disabledAt ? r.disabledAt.toISOString() : null,
        hasPassword: r.hasPassword,
        passkeyCount: r.passkeyCount,
        vaultLinked: r.vaultLinked,
        activeSessions: r.activeSessions,
        pushSubscriptions: r.pushSubscriptions,
      })),
    };
    return res;
  });

  // ── sessions for one user ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/admin/users/:id/sessions', async (req) => {
    const userId = parseBigint(req.params.id, 'id');
    if (userId === undefined) throw validation('id required');
    const currentToken = req.cookies[SESSION_COOKIE];

    const rows = await db
      .select({
        id: sessions.id,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.createdAt));

    const res: AdminSessionsResponse = {
      sessions: rows.map((r) => ({
        // ⚠️ The session id IS the bearer token. Never send it to a client —
        // an admin page that leaked one would hand over every account it
        // listed. The UI addresses a session by its index-free identity below.
        id: hashForDisplay(r.id),
        userAgent: r.userAgent,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        current: r.id === currentToken,
      })),
    };
    return res;
  });

  // ── invites ─────────────────────────────────────────────────────────────
  app.get('/admin/invites', async () => {
    const creator = db.$with('creator').as(db.select({ id: users.id, username: users.username }).from(users));
    const claimer = db.$with('claimer').as(db.select({ id: users.id, username: users.username }).from(users));

    const rows = await db
      .with(creator, claimer)
      .select({
        code: inviteCodes.code,
        createdAt: inviteCodes.createdAt,
        usedAt: inviteCodes.usedAt,
        revokedAt: inviteCodes.revokedAt,
        usedBy: inviteCodes.usedBy,
        createdByUsername: sql<string | null>`${creator.username}`,
        usedByUsername: sql<string | null>`${claimer.username}`,
      })
      .from(inviteCodes)
      .leftJoin(creator, eq(creator.id, inviteCodes.createdBy))
      .leftJoin(claimer, eq(claimer.id, inviteCodes.usedBy))
      .orderBy(desc(inviteCodes.createdAt));

    const invites: AdminInvite[] = rows.map((r) => ({
      code: r.code,
      createdAt: r.createdAt.toISOString(),
      createdByUsername: r.createdByUsername,
      usedByUsername: r.usedByUsername,
      usedAt: r.usedAt ? r.usedAt.toISOString() : null,
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
      claimable: r.usedBy === null && r.revokedAt === null,
    }));
    const res: AdminInvitesResponse = { invites };
    return res;
  });

  // ── push health ─────────────────────────────────────────────────────────
  app.get('/admin/push-health', async () => {
    const rows = await db
      .select({
        userId: users.id,
        username: users.username,
        subscriptions: count(pushSubscriptions.id),
      })
      .from(users)
      .leftJoin(pushSubscriptions, eq(pushSubscriptions.userId, users.id))
      .groupBy(users.id, users.username)
      .orderBy(users.username);

    const res: AdminPushHealthResponse = {
      users: rows.map((r) => ({
        userId: r.userId.toString(),
        username: r.username,
        subscriptions: Number(r.subscriptions),
      })),
      // Without this, "everyone has 0 subscriptions" and "push isn't
      // configured on this server" look identical in the UI.
      pushConfigured: Boolean(env.vapidPublicKey && env.vapidPrivateKey),
    };
    return res;
  });
}

/**
 * A stable, non-reversible display handle for a session.
 *
 * ⚠️ `sessions.id` is the raw bearer token (auth/session.ts) — sending it to a
 * client would let an admin page impersonate every session it listed, which is
 * the exact opposite of what a security console is for. This gives the UI
 * something to render and, later, to address a revoke at, without the value
 * itself being usable as a credential. The state-changing half addresses a
 * revoke by re-hashing candidate tokens server-side rather than accepting one.
 */
function hashForDisplay(token: string): string {
  // Node's crypto is imported lazily here to keep the route module's imports
  // about routing; this is the only cryptographic thing in the file.
  return createHash('sha256').update(token).digest('base64url').slice(0, 16);
}
