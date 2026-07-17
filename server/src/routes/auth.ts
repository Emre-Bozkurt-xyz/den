/**
 * Auth & identity routes (BACKBONE §6, §10). MVP = invite code + password.
 *
 * ⚠️ Assumptions future OAuth/passkey work MUST honour (do not design against
 * these — they are load-bearing per §5):
 *   - Invites AUTHORIZE, providers AUTHENTICATE. OAuth/passkey login must still
 *     require an unused invite code to CREATE an account; they only replace the
 *     password as the auth factor for RETURNING users.
 *   - Returning OAuth users are matched on (provider, provider_user_id) — the
 *     `auth_identities` table — NEVER on email. Never auto-merge by email.
 *   - A user must always retain ≥1 login method. Password is method #1 today.
 *   - Reserved routes /auth/oauth/* and /auth/passkey/* are NOT built here and
 *     their paths must not be reused (CLAUDE.md scope rules).
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuthLimits, type AuthResponse, type MeResponse } from '@den/shared';
import type { LoginRequest, RegisterRequest, UpdateMeRequest } from '@den/shared';
import { db } from '../db/index.js';
import { inviteCodes, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createSession, destroySession, requireAuth } from '../auth/session.js';
import { toPublicUser } from '../mappers.js';
import { AppError } from '../errors.js';
import { ErrorCode } from '@den/shared';

const USERNAME_RE = new RegExp(AuthLimits.usernamePattern);

// A real argon2id hash of a throwaway string. When a login names a nonexistent
// user we still run a verify against this so response time doesn't reveal whether
// the username exists (no enumeration via timing).
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$3df8NcXPfjjCLMMlwarJwQ$rXao8CFUDC9sfU9ACYh2M9pc28BKkyYbywHzRlesj5s';

function normUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError(400, ErrorCode.Validation, 'username required');
  const u = raw.trim().toLowerCase();
  if (u.length < AuthLimits.usernameMin || u.length > AuthLimits.usernameMax) {
    throw new AppError(
      400,
      ErrorCode.Validation,
      `username must be ${AuthLimits.usernameMin}–${AuthLimits.usernameMax} characters`,
    );
  }
  if (!USERNAME_RE.test(u)) {
    throw new AppError(400, ErrorCode.Validation, 'username may use only a–z, 0–9, _ and -');
  }
  return u;
}

function checkPassword(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < AuthLimits.passwordMin) {
    throw new AppError(400, ErrorCode.Validation, `password must be ≥ ${AuthLimits.passwordMin} characters`);
  }
  if (raw.length > AuthLimits.passwordMax) {
    throw new AppError(400, ErrorCode.Validation, 'password too long');
  }
  return raw;
}

function checkDisplayName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const name = s || fallback;
  if (name.length > AuthLimits.displayNameMax) {
    throw new AppError(400, ErrorCode.Validation, `display name too long (max ${AuthLimits.displayNameMax})`);
  }
  return name;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Rate-limit the credential endpoints (BACKBONE §10). Generous but bounded.
  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  // ── register ──────────────────────────────────────────────────────────────
  app.post<{ Body: RegisterRequest }>('/auth/register', authLimit, async (req, reply) => {
    const body = req.body ?? ({} as RegisterRequest);
    const username = normUsername(body.username);
    const password = checkPassword(body.password);
    const displayName = checkDisplayName(body.displayName, username);
    const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
    if (!inviteCode) throw new AppError(400, ErrorCode.InvalidInvite, 'invite code required');

    const passwordHash = await hashPassword(password);

    // Transaction: claim invite (single-use) + create user, atomically.
    const user = await db.transaction(async (tx) => {
      // Claim the invite only if it exists AND is unused — the WHERE guards the race.
      const claimed = await tx
        .update(inviteCodes)
        .set({ usedAt: sql`now()` })
        .where(and(eq(inviteCodes.code, inviteCode), isNull(inviteCodes.usedBy)))
        .returning({ code: inviteCodes.code });
      if (claimed.length === 0) {
        throw new AppError(400, ErrorCode.InvalidInvite, 'invite code is invalid or already used');
      }

      let inserted;
      try {
        inserted = await tx
          .insert(users)
          .values({ username, displayName, passwordHash })
          .returning({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarKey: users.avatarKey,
          });
      } catch (e) {
        // Unique violation on username → friendly error, rolls back invite claim.
        if (isUniqueViolation(e)) {
          throw new AppError(409, ErrorCode.UsernameTaken, 'that username is taken');
        }
        throw e;
      }
      const created = inserted[0]!;
      // Attribute the claimed invite to the new user.
      await tx.update(inviteCodes).set({ usedBy: created.id }).where(eq(inviteCodes.code, inviteCode));
      return created;
    });

    await createSession(reply, user.id, req.headers['user-agent']);
    const res: AuthResponse = toPublicUser(user);
    return reply.status(201).send(res);
  });

  // ── login ───────────────────────────────────────────────────────────────
  app.post<{ Body: LoginRequest }>('/auth/login', authLimit, async (req, reply) => {
    const body = req.body ?? ({} as LoginRequest);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarKey: users.avatarKey,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    const row = rows[0];
    // Same error whether the user is missing or the password is wrong (no
    // enumeration). Always run a real verify — against DUMMY_HASH when absent —
    // so timing doesn't leak existence.
    const ok = await verifyPassword(row?.passwordHash ?? DUMMY_HASH, password);
    if (!row || !row.passwordHash || !ok) {
      throw new AppError(401, ErrorCode.InvalidCredentials, 'incorrect username or password');
    }

    await createSession(reply, row.id, req.headers['user-agent']);
    const res: AuthResponse = toPublicUser(row);
    return res;
  });

  // ── logout ────────────────────────────────────────────────────────────────
  app.post('/auth/logout', async (req, reply) => {
    await destroySession(req, reply);
    return { ok: true };
  });

  // ── me ──────────────────────────────────────────────────────────────────
  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const res: MeResponse = toPublicUser(req.user!);
    return res;
  });

  // ── settings stub: update display name (avatar upload = Stage 3/R2) ─────────
  app.patch<{ Body: UpdateMeRequest }>('/me', { preHandler: requireAuth }, async (req) => {
    const me = req.user!;
    const displayName = checkDisplayName(req.body?.displayName, me.displayName);
    await db.update(users).set({ displayName }).where(eq(users.id, me.id));
    const res: MeResponse = toPublicUser({ ...me, displayName });
    return res;
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
