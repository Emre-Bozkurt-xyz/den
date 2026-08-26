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
 * The state-changing routes at the bottom follow two rules without exception:
 * every one writes a `security_events` row naming its actor (a console that
 * cannot say who did what manufactures deniability), and the irreversible ones
 * sit behind `requireFreshAuth` (§6) — a valid 30-day session is a weak
 * credential for "disable this account".
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gt, gte, inArray, isNull, sql } from 'drizzle-orm';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
  ErrorCode,
  LoginThrottle,
  type AdminInvite,
  type AdminInvitesResponse,
  type AdminLocksResponse,
  type AdminPushHealthResponse,
  type AdminSessionsResponse,
  type AdminUsersResponse,
  type MintInvitesRequest,
  type MintInvitesResponse,
  type ReauthPasskeyVerifyRequest,
  type ReauthPasswordRequest,
  type ReauthStatus,
  type SecurityEvent,
  type SecurityEventsResponse,
} from '@den/shared';
import { db } from '../db/index.js';
import {
  inviteCodes,
  loginFailures,
  pushSubscriptions,
  sessions,
  users,
  webauthnCredentials,
} from '../db/schema.js';
import { requireOwner } from '../auth/owner.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { checkLock, clearFailures } from '../auth/throttle.js';
import {
  REAUTH_TTL_MS,
  grantReauth,
  reauthRemainingSeconds,
  requireFreshAuth,
  verifyOwnPassword,
} from '../auth/reauth.js';
import { expectedOrigins, passkeyFailed, rpID, setChallenge, takeChallenge } from '../auth/webauthn.js';
import { SecurityEventKind, listEvents, record } from '../admin/events.js';
import { clientIp } from '../auth/clientIp.js';
import { generateInviteCodes } from '../admin/invites.js';
import { env } from '../env.js';
import { AppError, forbidden, notFound, validation } from '../errors.js';

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

  // ══ state-changing half ═════════════════════════════════════════════════
  //
  // Two rules, no exceptions: every route below writes a security_events row
  // naming its actor, and the irreversible ones require fresh proof of
  // identity (§6). `requireFreshAuth` is passed per-route rather than hooked,
  // because the low-harm actions deliberately do NOT require it — a re-auth
  // prompt on every unlock would train the owner to click through it, which is
  // how a confirmation step stops being a control.

  /** How much re-auth freshness is left, and how this account can refresh it. */
  app.get('/admin/reauth', async (req, reply) => {
    const me = req.user!;
    const [creds, methods] = await Promise.all([
      db
        .select({ id: webauthnCredentials.id })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, me.id)),
      db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, me.id))
        .limit(1),
    ]);
    const res: ReauthStatus = {
      freshSeconds: reauthRemainingSeconds(req, reply, me.id),
      canUsePasskey: creds.length > 0,
      canUsePassword: Boolean(methods[0]?.passwordHash),
    };
    return res;
  });

  /** Re-auth by password. Rate-limited: it is a password oracle otherwise. */
  app.post<{ Body: ReauthPasswordRequest }>(
    '/admin/reauth/password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const me = req.user!;
      const ok = await verifyOwnPassword(me.id, req.body?.password ?? '');
      if (!ok) {
        req.log.warn({ userId: me.id.toString() }, 'admin re-auth failed');
        throw new AppError(401, ErrorCode.InvalidCredentials, 'That password is not right');
      }
      grantReauth(reply, me.id, 'password');
      return { ok: true, freshSeconds: Math.ceil(REAUTH_TTL_MS / 1000) };
    },
  );

  /** Re-auth by passkey — options half. */
  app.post('/admin/reauth/passkey/options', async (req, reply) => {
    const me = req.user!;
    const creds = await db
      .select({ id: webauthnCredentials.id, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, me.id));
    if (creds.length === 0) throw validation('no passkeys on this account');

    const options = await generateAuthenticationOptions({
      rpID: rpID(),
      userVerification: 'preferred',
      // ⚠️ Unlike sign-in, this ceremony names the allowed credentials. Sign-in
      // must stay discoverable (no username, no oracle); here we already know
      // who is asking, and constraining it stops a different account's passkey
      // from satisfying an owner's re-auth prompt.
      allowCredentials: creds.map((c) => ({ id: c.id, transports: (c.transports ?? []) as never })),
    });
    setChallenge(reply, options.challenge, me.id);
    return options;
  });

  /** Re-auth by passkey — verify half. */
  app.post<{ Body: ReauthPasskeyVerifyRequest }>(
    '/admin/reauth/passkey/verify',
    async (req, reply) => {
      const me = req.user!;
      const { challenge, userId } = takeChallenge(req, reply);
      if (userId !== me.id.toString()) throw passkeyFailed();

      const response = req.body?.response as unknown as AuthenticationResponseJSON | undefined;
      if (!response?.id) throw passkeyFailed();

      const rows = await db
        .select({
          id: webauthnCredentials.id,
          publicKey: webauthnCredentials.publicKey,
          signCount: webauthnCredentials.signCount,
          transports: webauthnCredentials.transports,
          userId: webauthnCredentials.userId,
        })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.id, response.id))
        .limit(1);

      const cred = rows[0];
      // The credential must exist AND belong to the caller. Without the second
      // half, anyone's passkey would satisfy the owner's re-auth prompt.
      if (!cred || cred.userId !== me.id) throw passkeyFailed();

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge,
          expectedOrigin: expectedOrigins(),
          expectedRPID: rpID(),
          credential: {
            id: cred.id,
            publicKey: new Uint8Array(cred.publicKey),
            counter: Number(cred.signCount),
            transports: (cred.transports ?? []) as never,
          },
        });
      } catch {
        throw passkeyFailed();
      }
      if (!verification.verified) throw passkeyFailed();

      const stored = Number(cred.signCount);
      const presented = verification.authenticationInfo.newCounter;
      if ((stored > 0 || presented > 0) && presented <= stored) throw passkeyFailed();

      await db
        .update(webauthnCredentials)
        .set({ signCount: BigInt(presented), lastUsedAt: new Date() })
        .where(eq(webauthnCredentials.id, cred.id));

      grantReauth(reply, me.id, 'passkey');
      return { ok: true, freshSeconds: Math.ceil(REAUTH_TTL_MS / 1000) };
    },
  );

  // ── clear a login lock (no re-auth: reversible and low-harm) ─────────────
  app.post<{ Params: { username: string } }>('/admin/locks/:username/clear', async (req) => {
    const me = req.user!;
    const username = req.params.username.trim().toLowerCase();
    const cleared = await clearFailures(username);
    await record({
      kind: SecurityEventKind.LockCleared,
      username,
      actorUserId: me.id,
      ip: clientIp(req, env.trustedProxy),
      userAgent: req.headers['user-agent'] ?? null,
      data: { cleared },
    });
    return { ok: true, cleared };
  });

  // ── mint invites (no re-auth: creates nothing that can be taken away) ────
  app.post<{ Body: MintInvitesRequest }>('/admin/invites', async (req) => {
    const me = req.user!;
    const count = Math.max(1, Math.min(10, Number(req.body?.count) || 1));
    const codes = generateInviteCodes(count);
    await db.insert(inviteCodes).values(codes.map((code) => ({ code, createdBy: me.id })));
    for (const code of codes) {
      await record({
        kind: SecurityEventKind.InviteMinted,
        actorUserId: me.id,
        ip: clientIp(req, env.trustedProxy),
        userAgent: req.headers['user-agent'] ?? null,
        data: { code },
      });
    }
    const res: MintInvitesResponse = { codes };
    return res;
  });

  // ── revoke an unused invite (re-auth: it is how someone gets in) ─────────
  app.delete<{ Params: { code: string } }>(
    '/admin/invites/:code',
    { preHandler: requireFreshAuth },
    async (req) => {
      const me = req.user!;
      const code = req.params.code.trim();
      // ⚠️ Only UNUSED, UNREVOKED codes. A claimed code is history — revoking
      // it would imply something about the account it created, which this does
      // not and must not do (that is what disable is for).
      const updated = await db
        .update(inviteCodes)
        .set({ revokedAt: new Date() })
        .where(and(eq(inviteCodes.code, code), isNull(inviteCodes.usedBy), isNull(inviteCodes.revokedAt)))
        .returning({ code: inviteCodes.code });
      if (updated.length === 0) throw notFound('no unused invite with that code');

      await record({
        kind: SecurityEventKind.InviteRevoked,
        actorUserId: me.id,
        ip: clientIp(req, env.trustedProxy),
        userAgent: req.headers['user-agent'] ?? null,
        data: { code },
      });
      return { ok: true };
    },
  );

  // ── revoke sessions (re-auth: signs someone out of every device) ─────────
  app.delete<{ Params: { id: string } }>(
    '/admin/users/:id/sessions',
    { preHandler: requireFreshAuth },
    async (req) => {
      const me = req.user!;
      const userId = parseBigint(req.params.id, 'id');
      if (userId === undefined) throw validation('id required');

      const currentToken = req.cookies[SESSION_COOKIE];
      const rows = await db
        .select({ id: sessions.id, userId: sessions.userId })
        .from(sessions)
        .where(eq(sessions.userId, userId));

      // ⚠️ Never revoke the caller's own current session as part of a bulk
      // action. Locking yourself out of the console mid-incident is a real
      // way to make a bad situation worse, and it is trivially avoidable.
      const doomed = rows.filter((r) => r.id !== currentToken).map((r) => r.id);
      if (doomed.length > 0) {
        await db.delete(sessions).where(inArray(sessions.id, doomed));
      }

      const target = await db
        .select({ username: users.username })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      await record({
        kind: SecurityEventKind.SessionRevoked,
        userId,
        username: target[0]?.username ?? null,
        actorUserId: me.id,
        ip: clientIp(req, env.trustedProxy),
        userAgent: req.headers['user-agent'] ?? null,
        data: { revoked: doomed.length, keptOwnSession: rows.length !== doomed.length },
      });
      return { ok: true, revoked: doomed.length };
    },
  );

  // ── disable / enable an account (re-auth: the sharpest thing here) ───────
  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/disable',
    { preHandler: requireFreshAuth },
    async (req) => {
      const me = req.user!;
      const userId = parseBigint(req.params.id, 'id');
      if (userId === undefined) throw validation('id required');

      // ⚠️ Guarded explicitly rather than trusting nobody to try it. Disabling
      // yourself would delete your own sessions and, if you are the only
      // owner, make the console unreachable from inside the app entirely —
      // recoverable only by editing the database by hand.
      if (userId === me.id) throw forbidden('You cannot disable your own account');

      const updated = await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(and(eq(users.id, userId), isNull(users.disabledAt)))
        .returning({ id: users.id, username: users.username });
      if (updated.length === 0) throw notFound('no such enabled user');

      // Sessions are deleted as cleanup; resolveSession refusing a disabled
      // user is what actually enforces this (auth/session.ts).
      await db.delete(sessions).where(eq(sessions.userId, userId));

      await record({
        kind: SecurityEventKind.UserDisabled,
        userId,
        username: updated[0]!.username,
        actorUserId: me.id,
        ip: clientIp(req, env.trustedProxy),
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/users/:id/enable',
    { preHandler: requireFreshAuth },
    async (req) => {
      const me = req.user!;
      const userId = parseBigint(req.params.id, 'id');
      if (userId === undefined) throw validation('id required');

      const updated = await db
        .update(users)
        .set({ disabledAt: null })
        .where(eq(users.id, userId))
        .returning({ id: users.id, username: users.username });
      if (updated.length === 0) throw notFound('no such user');

      await record({
        kind: SecurityEventKind.UserEnabled,
        userId,
        username: updated[0]!.username,
        actorUserId: me.id,
        ip: clientIp(req, env.trustedProxy),
        userAgent: req.headers['user-agent'] ?? null,
      });
      return { ok: true };
    },
  );
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
