/**
 * Fresh-proof-of-identity gate (docs/ADMIN_CONSOLE.md §6).
 *
 * The destructive admin actions require more than a valid session: they
 * require that the person holding it proved who they are in the last few
 * minutes. A 30-day rolling session cookie is a reasonable credential for
 * reading a chat; it is a weak one for "disable this account" or "sign
 * everyone out", which are the two things a stolen laptop would be used for.
 *
 * ⚠️ This is NOT a second authentication factor. It re-runs the SAME factor
 * the user already has (their passkey, or their password), and its whole value
 * is recency — it shortens the window in which an unattended, already-signed-in
 * browser can do irreversible things. Do not describe it as MFA.
 *
 * Storage follows the WebAuthn-challenge precedent (auth/webauthn.ts): a
 * short-lived, signed, path-scoped cookie rather than a table. Nothing to
 * sweep, and it survives a restart the way server memory would not.
 */
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode } from '@den/shared';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { env } from '../env.js';
import { AppError } from '../errors.js';
import { verifyPassword } from './password.js';

const REAUTH_COOKIE = 'den_reauth';
const REAUTH_COOKIE_PATH = '/api/admin';
/** How long a proof stays fresh. Long enough to do a few things in one sitting,
 *  short enough that a walked-away-from browser goes cold quickly. */
export const REAUTH_TTL_MS = 5 * 60 * 1000;

interface ReauthPayload {
  /** Whose proof this is — a marker minted for A must not authorize B. */
  userId: string;
  /** Absolute expiry, ms since epoch. */
  exp: number;
  /** How they proved it, for the audit trail. */
  method: 'passkey' | 'password';
}

export function grantReauth(
  reply: FastifyReply,
  userId: bigint,
  method: ReauthPayload['method'],
): void {
  const payload: ReauthPayload = {
    userId: userId.toString(),
    exp: Date.now() + REAUTH_TTL_MS,
    method,
  };
  reply.setCookie(REAUTH_COOKIE, JSON.stringify(payload), {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    signed: true,
    path: REAUTH_COOKIE_PATH,
    maxAge: Math.ceil(REAUTH_TTL_MS / 1000),
  });
}

/** How much freshness is left, in seconds. 0 when there is none. */
export function reauthRemainingSeconds(req: FastifyRequest, reply: FastifyReply, userId: bigint): number {
  const raw = req.cookies[REAUTH_COOKIE];
  if (!raw) return 0;
  const unsigned = reply.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return 0;
  try {
    const payload = JSON.parse(unsigned.value) as ReauthPayload;
    // ⚠️ Check the subject, not just the expiry. Signing proves WE minted it,
    // not that it belongs to the caller — without this, a marker obtained on
    // one account would authorize actions taken while signed in as another.
    if (payload.userId !== userId.toString()) return 0;
    const left = payload.exp - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  } catch {
    return 0;
  }
}

/**
 * Fastify preHandler for destructive routes. Must be composed AFTER
 * `requireOwner`, which is what puts `req.user` in place.
 *
 * 401 with a distinct code rather than 403: the caller is allowed to do this,
 * they just need to prove themselves again, and the client has to be able to
 * tell those apart to show a re-auth prompt instead of an error.
 */
export async function requireFreshAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const me = req.user;
  if (!me) throw new AppError(401, ErrorCode.Unauthorized, 'Not authenticated');
  if (reauthRemainingSeconds(req, reply, me.id) <= 0) {
    throw new AppError(
      401,
      ErrorCode.ReauthRequired,
      'Confirm it is you before making this change',
    );
  }
}

/** Verify a password for re-auth. Returns false for OAuth-only accounts. */
export async function verifyOwnPassword(userId: bigint, password: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0) return false;
  const rows = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const hash = rows[0]?.passwordHash;
  if (!hash) return false;
  return verifyPassword(hash, password);
}

/** Drop the marker — used after a destructive action the user should re-confirm
 *  for, and on logout. Cheap and safe to call when none exists. */
export function clearReauth(reply: FastifyReply): void {
  reply.clearCookie(REAUTH_COOKIE, { path: REAUTH_COOKIE_PATH });
}
