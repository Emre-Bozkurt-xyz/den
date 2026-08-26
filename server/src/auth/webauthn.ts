/**
 * WebAuthn plumbing (docs/PASSKEYS.md §5).
 *
 * Everything cryptographic is delegated to `@simplewebauthn/server` — CBOR,
 * COSE and attestation parsing are exactly the kind of code that is wrong in
 * ways nobody notices. This module owns only the parts that are Den's:
 * deriving the RP identity, carrying a challenge between the two halves of a
 * ceremony, and the ≥1-login-method rule.
 *
 * ⚠️ **rpID is permanent.** A passkey binds to the domain forever; once one
 * real credential exists, moving Den to another registrable domain invalidates
 * every credential for every user, with no migration path. `den.ems-place.com`
 * was confirmed final by the owner on 2026-08-26 (PROJECT.md §14). Deriving it
 * from PUBLIC_ORIGIN rather than hardcoding it means dev/prod agree; it does
 * not make it safe to change.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode } from '@den/shared';
import { db } from '../db/index.js';
import { users, webauthnCredentials } from '../db/schema.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';

/** Human-facing name in the OS passkey prompt. */
export const RP_NAME = 'Den';

/**
 * The registrable domain, derived from PUBLIC_ORIGIN. Note this is the HOST
 * only — no scheme, no port — which is what the spec means by rpID and a
 * classic place to get it subtly wrong.
 */
export function rpID(): string {
  return new URL(env.publicOrigin).hostname;
}

/**
 * Origins the browser is allowed to claim. Exactly PUBLIC_ORIGIN in prod. In
 * dev the Vite server (5173) and the API (3000) are different origins, so both
 * are accepted — ⚠️ never let this list grow in prod, since an extra origin is
 * an extra site that can drive a ceremony against these credentials.
 */
export function expectedOrigins(): string[] {
  const origin = new URL(env.publicOrigin).origin;
  if (env.isProd) return [origin];
  return [...new Set([origin, 'http://localhost:5173', 'http://localhost:3000'])];
}

// ─── challenge transport ────────────────────────────────────────────────────

/**
 * A challenge lives in a short-lived signed cookie, not a table.
 *
 * This follows the precedent set by Vault's OAuth PKCE state
 * (`routes/integrations-vault.ts`), which reasoned that a server-set,
 * httpOnly, path-scoped cookie *is* the "one-time row" — same properties, no
 * schema, and nothing to sweep. It also beats in-memory state, which would
 * break across a restart or a second process.
 *
 * ⚠️ Signed (`signed: true`) matters here: the challenge is the thing the
 * assertion is checked against, so a client that could rewrite it could replay
 * an old assertion. `@fastify/cookie` is registered with `env.sessionSecret`
 * in app.ts, which is what makes signing available.
 */
const CHALLENGE_COOKIE = 'den_webauthn';
const CHALLENGE_COOKIE_PATH = '/api/auth/passkey';
/** Ceremonies are a prompt and a fingerprint; two minutes is generous. */
const CHALLENGE_MAX_AGE_S = 2 * 60;

interface ChallengePayload {
  challenge: string;
  /** Set for registration (the session user it will attach to); null for login,
   *  where no user is known until the assertion names one. Registration binds
   *  it so a challenge minted for A can never be completed as B. */
  userId: string | null;
}

export function setChallenge(reply: FastifyReply, challenge: string, userId: bigint | null): void {
  const payload: ChallengePayload = { challenge, userId: userId ? userId.toString() : null };
  reply.setCookie(CHALLENGE_COOKIE, JSON.stringify(payload), {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    signed: true,
    path: CHALLENGE_COOKIE_PATH,
    maxAge: CHALLENGE_MAX_AGE_S,
  });
}

/**
 * Read and immediately invalidate the challenge — one ceremony per challenge,
 * always. The clear happens even on the failure paths below, so a bad attempt
 * cannot be retried against the same challenge.
 */
export function takeChallenge(req: FastifyRequest, reply: FastifyReply): ChallengePayload {
  const raw = req.cookies[CHALLENGE_COOKIE];
  reply.clearCookie(CHALLENGE_COOKIE, { path: CHALLENGE_COOKIE_PATH });
  if (!raw) throw passkeyFailed();

  const unsigned = reply.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) throw passkeyFailed();

  try {
    const parsed = JSON.parse(unsigned.value) as ChallengePayload;
    if (typeof parsed.challenge !== 'string' || !parsed.challenge) throw passkeyFailed();
    return parsed;
  } catch {
    throw passkeyFailed();
  }
}

/**
 * One error for every ceremony failure — expired challenge, bad signature,
 * unknown credential, wrong user. ⚠️ Deliberately undifferentiated: telling a
 * caller *which* step failed tells an attacker which half to work on, and
 * there is no legitimate client that needs to know the difference (every case
 * has the same remedy: try again, or use your password).
 */
export function passkeyFailed(): AppError {
  return new AppError(400, ErrorCode.PasskeyFailed, 'Could not complete the passkey request');
}

// ─── the ≥1-login-method rule ───────────────────────────────────────────────

export interface LoginMethods {
  hasPassword: boolean;
  passkeyCount: number;
}

/** What ways this user currently has to sign in. */
export async function loginMethodsFor(userId: bigint): Promise<LoginMethods> {
  const [userRows, credRows] = await Promise.all([
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), isNotNull(users.passwordHash)))
      .limit(1),
    db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId)),
  ]);
  return { hasPassword: userRows.length > 0, passkeyCount: credRows.length };
}

/**
 * Refuse to remove a user's last way in (BACKBONE §5, docs/PASSKEYS.md §9).
 *
 * ⚠️ Counts passwords and passkeys **together**, deliberately, even though
 * Option A means every account currently keeps a password and this can
 * therefore never fire today. It is written this way so that if per-user
 * password retirement is ever revisited (icebox), the guard is already correct
 * rather than being a thing someone has to remember to widen.
 */
export async function assertNotLastLoginMethod(userId: bigint): Promise<void> {
  const { hasPassword, passkeyCount } = await loginMethodsFor(userId);
  const remaining = (hasPassword ? 1 : 0) + Math.max(0, passkeyCount - 1);
  if (remaining < 1) {
    throw new AppError(
      409,
      ErrorCode.LastLoginMethod,
      'That is your only way to sign in — add another passkey or set a password first.',
    );
  }
}

// ─── misc ───────────────────────────────────────────────────────────────────

/**
 * A stable, opaque per-user handle for the authenticator to store.
 *
 * ⚠️ NOT the username and NOT the user id. The user handle is written into the
 * credential on the device and shows up in passkey managers; a username there
 * would leak into any context the device syncs to, and an id would tie a
 * public artifact to our primary keys. A random handle stored alongside the
 * credential is the spec's intent. We derive it per registration and keep it
 * only inside the ceremony — discoverable login resolves the credential by its
 * own ID, so nothing needs to look this up afterwards.
 */
export function newUserHandle(): Uint8Array<ArrayBuffer> {
  // ⚠️ Copy into a fresh ArrayBuffer rather than wrapping the Buffer's: Node's
  // Buffer pools small allocations, so `new Uint8Array(buf.buffer)` would be a
  // view over shared pool memory. The library's type also demands the narrower
  // `Uint8Array<ArrayBuffer>`, which a pooled view does not satisfy.
  const bytes = new Uint8Array(new ArrayBuffer(32));
  bytes.set(randomBytes(32));
  return bytes;
}

/** Fallback label when the user doesn't name a credential. */
export function defaultLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/iphone/i.test(ua)) return 'iPhone';
  if (/ipad/i.test(ua)) return 'iPad';
  if (/android/i.test(ua)) return 'Android device';
  if (/macintosh|mac os/i.test(ua)) return 'Mac';
  if (/windows/i.test(ua)) return 'Windows PC';
  return 'Passkey';
}
