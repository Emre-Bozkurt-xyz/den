/**
 * Ending a session must end its sockets too.
 *
 * ⚠️ A socket authenticates ONCE, at the handshake (ws.ts), and before this
 * module nothing ever looked at it again. So logout, admin "disable user",
 * admin "revoke sessions" and plain session expiry all deleted the `sessions`
 * row and left the socket running — still receiving every frame in every chat
 * room (presigned media URLs included) and still able to send. Deleting the
 * row only stops the NEXT handshake; this module stops the current one.
 *
 * Two layers, deliberately:
 *   1. Immediate: whoever deletes session rows calls `disconnectSession` /
 *      `disconnectUser` in the same request. This is the mechanism.
 *   2. Coarse sweep (`startSessionRecheck`): every socket's session is
 *      re-validated on an interval, in ONE batched query for all sockets — not
 *      a lookup per frame. This is the backstop for anything that deletes or
 *      expires sessions without going through (1): CLI scripts, a row deleted
 *      by hand, the 30-day expiry, and the race where a handshake's lookup
 *      reads a session a moment before a logout deletes it.
 *
 * `disconnect(true)` closes the transport and is reported to the client as
 * "io server disconnect", which socket.io-client deliberately does NOT
 * auto-reconnect from — exactly right for a revoked credential.
 */
import type { Server as IOServer } from 'socket.io';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { sessionRoom, userRoom } from './rooms.js';

/** Drop every socket opened with this one session token. No-op without io
 *  (route tests build the app without attaching socket.io). */
export function disconnectSession(io: IOServer | undefined, sessionToken: string): void {
  io?.in(sessionRoom(sessionToken)).disconnectSockets(true);
}

/** Drop every socket belonging to this user, on every device. For actions
 *  that end ALL of a user's sessions (admin disable). */
export function disconnectUser(io: IOServer | undefined, userId: bigint): void {
  io?.in(userRoom(userId)).disconnectSockets(true);
}

/** How often live sockets have their session re-checked. Coarse on purpose:
 *  the routes that end sessions disconnect immediately, so this only bounds
 *  how long a path that bypasses them can leave a socket alive. */
export const SESSION_RECHECK_MS = 60_000;

/** Postgres has a bind-parameter ceiling; a five-person circle will never get
 *  near it, but an unbounded IN list is how that assumption breaks quietly. */
const RECHECK_CHUNK = 500;

/** One pass: which of these tokens still name a live, enabled session? */
async function liveTokens(tokens: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  for (let i = 0; i < tokens.length; i += RECHECK_CHUNK) {
    const chunk = tokens.slice(i, i + RECHECK_CHUNK);
    const rows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(inArray(sessions.id, chunk), gt(sessions.expiresAt, new Date()), isNull(users.disabledAt)));
    for (const r of rows) live.add(r.id);
  }
  return live;
}

async function recheckOnce(io: IOServer): Promise<void> {
  const sockets = [...io.of('/').sockets.values()];
  const tokens = [
    ...new Set(sockets.map((s) => s.data.sessionToken as unknown).filter((t): t is string => typeof t === 'string')),
  ];
  if (tokens.length === 0) return;

  const live = await liveTokens(tokens);
  for (const s of sockets) {
    const token = s.data.sessionToken as unknown;
    // Every handshake records a token, so a socket without one is not
    // authenticated by anything we know of — fail closed rather than skip it.
    if (typeof token !== 'string' || !live.has(token)) s.disconnect(true);
  }
}

/**
 * Start the sweep. Returns a stop function. ⚠️ A failed sweep (DB blip) logs
 * and keeps every socket: disconnecting the whole circle because Postgres
 * hiccuped would be a self-inflicted outage, and the immediate path above is
 * what revocation actually rests on.
 */
export function startSessionRecheck(io: IOServer, intervalMs = SESSION_RECHECK_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // never stack sweeps behind a slow query
    running = true;
    recheckOnce(io)
      .catch((err) => console.error('ws session recheck failed:', err instanceof Error ? err.message : err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  // Never the reason the process stays alive.
  timer.unref();
  return () => clearInterval(timer);
}
