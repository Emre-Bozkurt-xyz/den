/**
 * Server-side sessions (BACKBONE §9, §10, hard invariant 9).
 *
 * A session is a random 256-bit token stored in the `sessions` table; the token
 * is the cookie value. httpOnly + Secure(prod) + SameSite=Lax. 30-day rolling
 * expiry. Logout deletes the row. No JWTs.
 *
 * ⚠️ Secure is prod-only: over http://localhost the browser drops Secure
 * cookies, which would break local dev. Same-origin on iOS installed PWA works
 * (tested-in-week-1 assumption from §3).
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { env } from '../env.js';
import { unauthorized } from '../errors.js';

export const SESSION_COOKIE = 'den_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const REFRESH_WHEN_UNDER_MS = 15 * 24 * 60 * 60 * 1000; // rolling: extend past halfway

/** The user attached to an authenticated request. */
export interface AuthedUser {
  id: bigint;
  username: string;
  displayName: string;
  avatarKey: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

function newToken(): string {
  return randomBytes(32).toString('base64url'); // 256-bit
}

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/',
    domain: env.cookieDomain,
    expires: expiresAt,
  });
}

/** Create a session row + set the cookie. Returns the token. */
export async function createSession(
  reply: FastifyReply,
  userId: bigint,
  userAgent: string | undefined,
): Promise<string> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: token, userId, expiresAt, userAgent: userAgent ?? null });
  setSessionCookie(reply, token, expiresAt);
  return token;
}

/** Delete the current session row and clear the cookie. */
export async function destroySession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await db.delete(sessions).where(eq(sessions.id, token));
  reply.clearCookie(SESSION_COOKIE, { path: '/', domain: env.cookieDomain });
}

/**
 * Resolve the session cookie → user, refreshing the rolling expiry when it's
 * past halfway. Returns null when there's no valid session.
 */
export async function resolveSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthedUser | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;

  const rows = await db
    .select({
      expiresAt: sessions.expiresAt,
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      avatarKey: users.avatarKey,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, token))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  if (row.expiresAt.getTime() <= Date.now()) {
    // Expired — clean it up.
    await db.delete(sessions).where(eq(sessions.id, token));
    reply.clearCookie(SESSION_COOKIE, { path: '/', domain: env.cookieDomain });
    return null;
  }

  // Rolling refresh.
  if (row.expiresAt.getTime() - Date.now() < REFRESH_WHEN_UNDER_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, token));
    setSessionCookie(reply, token, expiresAt);
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    avatarKey: row.avatarKey,
  };
}

/**
 * Fastify preHandler: require a valid session, else 401. Attaches req.user.
 * Every authed route uses this; chat-scoped routes ALSO call assertMember later
 * (Stage 2) — authentication and authorization are separate gates.
 */
export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveSession(req, reply);
  if (!user) throw unauthorized();
  req.user = user;
}
