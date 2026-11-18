/**
 * socket.io room-name helpers. Standalone (no other project imports) so both
 * `ws.ts` and the push module can depend on it without a cycle.
 *
 *   user:{id}       — one user, all their tabs/devices; chat-agnostic notices
 *                     (chat.created, friend.*), and "disconnect every socket
 *                     this account has" (admin disable).
 *   chat:{id}       — every member of that chat; message fanout target.
 *   session:{hash}  — every socket opened with ONE session cookie, so a
 *                     logout or a per-session revoke can drop exactly those
 *                     sockets and leave the user's other devices alone.
 */
import { createHash } from 'node:crypto';

export const chatRoom = (chatId: bigint | string): string => `chat:${chatId}`;
export const userRoom = (userId: bigint | string): string => `user:${userId}`;

/**
 * ⚠️ Keyed by a HASH of the session token, never the token itself. The token
 * is the bearer credential (auth/session.ts); room names show up in adapter
 * internals, debugging dumps and `socket.rooms`, none of which should ever be
 * holding something that logs you in.
 */
export const sessionRoom = (sessionToken: string): string =>
  `session:${createHash('sha256').update(sessionToken).digest('base64url').slice(0, 32)}`;
