/**
 * Typing state (docs/TYPING_INDICATORS.md).
 *
 * In-memory and per-socket, like `presence.ts` and for the same reason: the
 * fact expires in seconds, so there is no truth to persist. Hard invariant 3
 * ("server is truth, client is a cache") has nothing to say about a value that
 * is stale before it could be written down.
 *
 * ⚠️ **The whole module exists for one failure mode.** Someone types, their
 * tab dies — crash, tunnel, phone sleeps — and everyone else sees "Emre is
 * typing…" forever. The expiry timer below is the only defence that does not
 * depend on the dead client saying stop, which is why the server owns it
 * rather than trusting a `typing: false` frame to arrive.
 */
import { TypingTimings } from '@den/shared';

/** One live "X is typing in chat Y" claim. */
interface TypingEntry {
  timer: NodeJS.Timeout;
}

/** socketId → chatId → entry. Keyed by socket, not user: one person with two
 *  tabs open should not have one tab's stop cancel the other's typing. */
const bySocket = new Map<string, Map<string, TypingEntry>>();

/**
 * Record that this socket is typing in this chat, (re)arming the expiry.
 *
 * `onExpire` fires if no refresh arrives in time — the server announcing the
 * stop on the client's behalf. Returns true when this is a NEW claim, so the
 * caller can skip re-broadcasting a state everyone already has (a refresh
 * every 3s per typing user would otherwise be a frame per 3s per member).
 */
export function setTyping(
  socketId: string,
  chatId: string,
  onExpire: () => void,
): boolean {
  let chats = bySocket.get(socketId);
  if (!chats) {
    chats = new Map();
    bySocket.set(socketId, chats);
  }

  const existing = chats.get(chatId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    const current = bySocket.get(socketId);
    current?.delete(chatId);
    if (current && current.size === 0) bySocket.delete(socketId);
    onExpire();
  }, TypingTimings.serverExpiryMs);
  // Never hold the process open for a typing indicator.
  timer.unref?.();

  chats.set(chatId, { timer });
  return existing === undefined;
}

/**
 * Clear one claim. Returns true if there was one — so a redundant stop (the
 * client sending `typing: false` after the server already expired it) does not
 * produce a second broadcast.
 */
export function clearTyping(socketId: string, chatId: string): boolean {
  const chats = bySocket.get(socketId);
  const entry = chats?.get(chatId);
  if (!entry || !chats) return false;
  clearTimeout(entry.timer);
  chats.delete(chatId);
  if (chats.size === 0) bySocket.delete(socketId);
  return true;
}

/**
 * Drop everything this socket claimed, returning the chats that had a live
 * claim so the caller can announce the stops. Called on disconnect — defence
 * #2 from the plan doc, and the one that handles a clean tab close instantly
 * rather than waiting out the expiry.
 */
export function clearSocket(socketId: string): string[] {
  const chats = bySocket.get(socketId);
  if (!chats) return [];
  const chatIds = [...chats.keys()];
  for (const entry of chats.values()) clearTimeout(entry.timer);
  bySocket.delete(socketId);
  return chatIds;
}

/** Test/diagnostic only: how many sockets currently claim to be typing. */
export function typingSocketCount(): number {
  return bySocket.size;
}
