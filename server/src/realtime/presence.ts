/**
 * Per-socket presence (docs/NOTIFICATIONS.md §2.1). Standalone, like
 * `rooms.ts`, so `ws.ts` (the writer) and `push/notify.ts` (the only reader)
 * can both depend on it without a cycle.
 *
 * ⚠️ The one thing to understand before touching this: room membership is
 * NOT presence. `ws.ts` joins every socket to *every* chat room its user
 * belongs to, so "there is a socket in `chat:{id}`" only ever meant "this
 * user has a socket somewhere" — which is why a backgrounded PWA used to
 * swallow its own notifications. Presence is the missing half: what that
 * socket is actually looking at.
 *
 * In-memory and per-socket by design (hard invariant 3 cuts the other way
 * here — there is nothing to persist). A reconnect re-reports it, and a
 * socket with no presence recorded is treated as not-active, so the failure
 * mode is an extra notification rather than a missing one.
 */
export interface SocketPresence {
  /** The chat on screen, or null for the chat list / gallery / settings. */
  chatId: string | null;
  /** `document.visibilityState === 'visible'` at the time of the report. */
  visible: boolean;
}

/** Socket.io's per-socket bag, narrowed to what this module cares about. */
interface PresenceSocketData {
  userId: bigint;
  presence?: SocketPresence;
}

/** True if this socket is a reason NOT to push `chatId` to its user: it is on
 *  that chat *and* the app is visible. Anything less — hidden, a different
 *  chat, no report at all — is a push. */
export function isWatching(data: unknown, chatId: string): boolean {
  const presence = (data as PresenceSocketData | undefined)?.presence;
  return presence?.visible === true && presence.chatId === chatId;
}
