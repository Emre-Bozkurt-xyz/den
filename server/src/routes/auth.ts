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
 *
 * Brute-force posture (docs/AUTH_HARDENING.md): the per-route rate limit below
 * is a flood backstop only — it keys on a client address that does not
 * currently survive Den's proxy chain. The bound that actually stops credential
 * guessing is the per-account throttle in auth/throttle.ts, keyed on the
 * submitted username. Both stay when passkeys/OAuth land: those add factors,
 * they don't remove the password path.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AuthLimits,
  LoginThrottle,
  DEFAULT_USER_SETTINGS,
  GIF_RATINGS,
  type AuthResponse,
  type MeResponse,
  type UserSettings,
} from '@den/shared';
import type { LoginRequest, RegisterRequest, UpdateMeRequest } from '@den/shared';
import { db } from '../db/index.js';
import { inviteCodes, users } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { checkLock, clearFailures, recordFailure, sweepExpired } from '../auth/throttle.js';
import { clientIp } from '../auth/clientIp.js';
import { notifyUser } from '../push/notify.js';
import { createSession, destroySession, requireAuth } from '../auth/session.js';
import { toPublicUser } from '../mappers.js';
import { AppError } from '../errors.js';
import { validation } from '../errors.js';
import { env, gifsEnabled } from '../env.js';
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

const SETTINGS_KEYS = Object.keys(DEFAULT_USER_SETTINGS) as (keyof UserSettings)[];

/**
 * Settings whose type is `string` but whose domain is a closed set
 * (docs/GIFS.md §9). `typeof` alone can't police these — every arbitrary
 * string passes a `typeof value === 'string'` check — so any enum-valued
 * setting MUST be listed here or it silently accepts junk. Keep this in step
 * with `UserSettings`: a new union-typed key needs an entry the same day.
 */
const SETTINGS_ENUMS: Partial<Record<keyof UserSettings, readonly string[]>> = {
  gifRating: GIF_RATINGS,
};

/** True when `value` is acceptable for `key` — right primitive type, and for
 *  enum-valued keys, a member of the allowed set. */
function isValidSettingValue(key: keyof UserSettings, value: unknown): boolean {
  if (typeof value !== typeof DEFAULT_USER_SETTINGS[key]) return false;
  const allowed = SETTINGS_ENUMS[key];
  return !allowed || allowed.includes(value as string);
}

/**
 * Sanitize a value read back from `users.settings` (docs/MEDIA_ATTACHMENTS.md
 * §4.2/§4.3, D11). Trusted-but-verify: only the server ever writes this
 * column, but a row may predate a key (pre-migration `{}`, or a key added
 * after the user's last PATCH) or — in principle — hold a shape from a buggy
 * prior version. Any key that's missing or wrong-typed is silently dropped;
 * callers fill the gap from `DEFAULT_USER_SETTINGS`. Never throws.
 */
function pickStoredSettings(stored: unknown): Partial<UserSettings> {
  if (typeof stored !== 'object' || stored === null) return {};
  const out: Partial<UserSettings> = {};
  for (const key of SETTINGS_KEYS) {
    const value = (stored as Record<string, unknown>)[key];
    if (isValidSettingValue(key, value)) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/**
 * Sanitize a client-supplied `PATCH /me` settings patch. Unlike the stored
 * side, client input that's wrong-typed is a validation error, not something
 * to silently coerce — the client should know better. Unknown keys are
 * dropped (never persisted, never an error) so an older/newer client can't
 * accidentally write junk just by sending an extra field.
 */
function pickPatchSettings(patch: unknown): Partial<UserSettings> {
  if (patch === undefined) return {};
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw validation('settings must be an object');
  }
  const out: Partial<UserSettings> = {};
  for (const key of SETTINGS_KEYS) {
    if (!(key in (patch as Record<string, unknown>))) continue;
    const value = (patch as Record<string, unknown>)[key];
    if (!isValidSettingValue(key, value)) {
      const allowed = SETTINGS_ENUMS[key];
      throw validation(
        allowed ? `settings.${key} must be one of: ${allowed.join(', ')}` : `settings.${key} must be a ${typeof DEFAULT_USER_SETTINGS[key]}`,
      );
    }
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Merge a stored settings value with an optional client patch into a
 * complete, valid `UserSettings` — the one function both GET and PATCH /me
 * route through. `patch` omitted (or `{}`) returns the stored settings
 * layered on the defaults, unchanged: `PATCH /me {settings:{}}` must not
 * wipe anything, and an older client's request for an unrelated field must
 * not clobber a newer preference it doesn't know about.
 */
export function mergeUserSettings(stored: unknown, patch: unknown): UserSettings {
  return {
    ...DEFAULT_USER_SETTINGS,
    ...pickStoredSettings(stored),
    ...pickPatchSettings(patch),
  };
}

/** Re-reads just the settings column — `req.user` (session.ts) doesn't carry it. */
async function fetchStoredSettings(userId: bigint): Promise<unknown> {
  const rows = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.settings;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Flood backstop on the credential endpoints (docs/AUTH_HARDENING.md §2.3).
  //
  // ⚠️ Raised from 10/min. At 10 this was a *global* bucket in prod — the real
  // client IP doesn't reach Fastify, so every member shared one allowance and
  // ten wrong passwords a minute from a stranger locked the whole circle out
  // of logging in. That was a cheaper attack than the guessing this was meant
  // to stop. Credential guessing is now bounded per-account by auth/throttle.ts,
  // which frees this to be what it should have been: a ceiling that only
  // pathological traffic reaches.
  const authLimit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

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
    const ip = clientIp(req, env.trustedProxy);
    const userAgent = req.headers['user-agent'] ?? null;

    // ── throttle gate (docs/AUTH_HARDENING.md §2.2) ────────────────────────
    // Checked BEFORE the password is verified, so a locked account costs an
    // attacker an indexed count() rather than an argon2 hash. ⚠️ This runs for
    // usernames that don't exist too — a lock that only applied to real
    // accounts would leak existence, undoing the DUMMY_HASH work below.
    const lock = await checkLock(username);
    if (lock.locked) {
      req.log.warn({ username, ip, failures: lock.failures, until: lock.until }, 'login refused: account locked');
      void reply.header('Retry-After', String(lock.retryAfterSeconds));
      throw new AppError(
        423,
        ErrorCode.AuthLocked,
        `Too many failed sign-in attempts. Try again in ${Math.ceil(lock.retryAfterSeconds / 60)} minute(s).`,
      );
    }

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
      const after = await recordFailure(username, ip, userAgent);
      req.log.warn({ username, ip, userAgent, failures: after.failures }, 'failed login');
      // Opportunistic housekeeping — Den has no background job runner, and
      // this table only grows while someone is failing to log in.
      void sweepExpired();
      // Tell the owner their account just locked — ONCE per lock, on the
      // attempt that crossed the threshold. ⚠️ Not `after.locked`: that stays
      // true for every subsequent failure, so a sustained attack would push a
      // notification per guess. The point is to alert, not to hand an attacker
      // a way to make someone's phone buzz all night.
      //
      // Fire-and-forget by contract: `row` may be undefined (no such user —
      // nobody to tell) and notifyUser never throws, so nothing here can
      // change the 401 below.
      if (after.failures === LoginThrottle.threshold && row) {
        void notifyUser(row.id, {
          title: 'Den · sign-in blocked',
          body: `${after.failures} failed sign-in attempts on your account in the last ${Math.round(
            LoginThrottle.windowMs / 60000,
          )} minutes. Sign-in is paused. If this wasn't you, change your password.`,
          topic: 'auth-alert',
        });
      }
      throw new AppError(401, ErrorCode.InvalidCredentials, 'incorrect username or password');
    }

    // Proving who you are resets your own counter — so a burst of wrong
    // guesses against you can never accumulate into a lock you can't clear.
    await clearFailures(username);
    await createSession(reply, row.id, userAgent ?? undefined);
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
    const me = req.user!;
    const stored = await fetchStoredSettings(me.id);
    const res: MeResponse = { ...toPublicUser(me), settings: mergeUserSettings(stored, undefined), gifsEnabled };
    return res;
  });

  // ── settings: display name + user preferences (avatar upload = Stage 3/R2) ──
  app.patch<{ Body: UpdateMeRequest }>('/me', { preHandler: requireAuth }, async (req) => {
    const me = req.user!;
    const displayName = checkDisplayName(req.body?.displayName, me.displayName);
    const stored = await fetchStoredSettings(me.id);
    const settings = mergeUserSettings(stored, req.body?.settings);
    await db.update(users).set({ displayName, settings }).where(eq(users.id, me.id));
    const res: MeResponse = { ...toPublicUser({ ...me, displayName }), settings, gifsEnabled };
    return res;
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
