/**
 * The WebSocket envelope — LOCKED shape (BACKBONE §4).
 *
 * Every realtime frame in Den, in both directions, is a `WsEnvelope`. New
 * features add new `type` string values; they never invent a second envelope
 * or a side-channel. Call signaling later is *just more `type` values*.
 */
export interface WsEnvelope<T extends string = string, P = unknown> {
  /** Dotted event name, e.g. "message.new", "message.send", "tag.added". */
  type: T;
  payload: P;
  /** Server timestamp (ms epoch) on server→client frames. */
  ts: number;
  /** Client-generated id for request/ack correlation. */
  reqId?: string;
}

/**
 * Reserved WS type prefixes (BACKBONE §11). MVP must NOT emit these — they are
 * held for 🔮 calls so signaling can ride the existing socket with no protocol
 * rework. Do not repurpose them.
 */
export const RESERVED_WS_PREFIXES = ['call.signal.', 'call.state.'] as const;

/** True if a WS type name collides with a reserved (call.*) prefix. */
export function isReservedWsType(type: string): boolean {
  return RESERVED_WS_PREFIXES.some((p) => type.startsWith(p));
}

/**
 * Known MVP WS type names. This is a living union — extend it as stages land.
 * Kept as a const map so both sides share exact string literals.
 */
export const WsType = {
  // connection / presence
  Hello: 'hello',
  Ping: 'ping',
  Pong: 'pong',
  /** Sent to a single socket when its request couldn't be fulfilled; `reqId`
   *  correlates back to the frame that failed. Never broadcast to a room. */
  Error: 'error',
  /** Client → server: which chat this socket is actually looking at
   *  (docs/NOTIFICATIONS.md §2.1). Push targeting reads it; nothing else does. */
  PresenceUpdate: 'presence.update',
  // messaging (Stage 2)
  MessageSend: 'message.send',
  MessageNew: 'message.new',
  // chat membership (Stage 2)
  ChatCreated: 'chat.created',
  // friending (Stage 2)
  FriendRequest: 'friend.request',
  FriendAccepted: 'friend.accepted',
  // media (Stage 3)
  MediaReady: 'media.ready',
  // embeds (post-MVP, docs/EMBEDS.md §4.2)
  EmbedReady: 'embed.ready',
  // tags (Stage 5)
  TagAdded: 'tag.added',
  TagRemoved: 'tag.removed',
  // message lifecycle (Stage 6 / §2 item 11)
  MessageDeleted: 'message.deleted',
  MessageRestored: 'message.restored',
  // message edit (post-MVP, docs/MESSAGE_EDIT.md)
  MessageEdited: 'message.edited',
  // reactions (post-MVP)
  ReactionAdded: 'reaction.added',
  ReactionRemoved: 'reaction.removed',
  // receipts (post-MVP, docs/RECEIPTS.md)
  DeliveredAck: 'delivered.ack',
  MessageDelivered: 'message.delivered',
  MessageRead: 'message.read',
} as const;

export type WsTypeName = (typeof WsType)[keyof typeof WsType];

// ─── presence (post-MVP, docs/NOTIFICATIONS.md §2.1) ────────────────────────

/**
 * Client → server: what this socket is looking at right now. Fire-and-forget,
 * per-socket, never persisted — a reconnect re-reports it.
 *
 * ⚠️ This exists for exactly one consumer: deciding whether a new message
 * needs a push. It is NOT a room subscription and NOT an online-status
 * broadcast — nothing is ever sent back, and no other user can observe it.
 *
 * `chatId` is the chat currently on screen (null = none — the chat list, the
 * gallery, settings). `visible` mirrors `document.visibilityState`. A push is
 * suppressed only when both agree: this socket is visible AND on that chat.
 * A socket that never reports presence counts as *not* active, so it gets the
 * push — the whole point is to fail toward notifying (docs/NOTIFICATIONS.md
 * §2.1).
 */
export interface PresenceUpdatePayload {
  chatId: string | null;
  visible: boolean;
}

// ─── payload shapes (Stage 2) — keep in sync with the emitters/handlers ─────

/** Client → server: send a text message. Server validates chat membership,
 *  persists, then broadcasts `MessageNew` to the chat room (sender included) —
 *  the client reconciles its optimistic bubble via the envelope's `reqId`. */
export interface MessageSendPayload {
  chatId: string;
  body: string;
  /** Post-MVP: id of the message this one replies to. */
  replyToId?: string;
  /** docs/GIFS.md §6 — send a picked GIF as an embed message. This is the
   *  "client sets an intent" half of docs/EMBEDS.md §4.3's mint path, which
   *  was designed from the start and unused until now; the other half (server
   *  sniffs `body` for an embeddable URL) still runs when this is absent.
   *
   *  Only the `slug` crosses the wire: the server re-fetches the GIF's
   *  metadata from Klipy itself and derives every URL and dimension, so a
   *  client can never dictate what bytes get stored (CLAUDE.md invariant 7).
   *  `body` MUST be empty when this is set — a GIF has no caption (D4), and
   *  silently dropping typed text would be worse than refusing the frame.
   *
   *  `width`/`height` are a **cosmetic layout hint**, not data: they size the
   *  `'processing'` placeholder that every *other* member receives, so the card
   *  lands at its final aspect instead of popping from a generic box when
   *  `embed.ready` arrives (owner report, 2026-08-14). They are the only
   *  client-declared values this feature accepts, and they are deliberately
   *  bounded rather than trusted — the server clamps the aspect ratio, ignores
   *  anything malformed, and the resolver **overwrites both with dimensions
   *  measured off the bytes it actually stored**. A lie here can at worst make
   *  one placeholder briefly the wrong shape for under a second; it can never
   *  affect what is fetched, stored, or served, which is what CLAUDE.md
   *  invariant 7 exists to protect. Optional: omitting them costs only a
   *  square placeholder. */
  gif?: { slug: string; width?: number; height?: number };
}

/** Server → client (room broadcast). */
export interface MessageNewPayload {
  message: import('./api.js').Message;
}

/** Server → client (single socket), sent to every member added to a new chat
 *  so their chat list updates without waiting on a refetch. */
export interface ChatCreatedPayload {
  chat: import('./api.js').ChatSummary;
}

/** Server → client (single socket): a friend request arrived. */
export interface FriendRequestPayload {
  from: import('./api.js').PublicUser;
}

/** Server → client (single socket): someone accepted your outgoing request. */
export interface FriendAcceptedPayload {
  by: import('./api.js').PublicUser;
}

/** Server → client (single socket): a request failed; `reqId` ties it back. */
export interface ErrorPayload {
  code: string;
  message: string;
}

/** Server → client (room broadcast), Stage 5: a tag was attached to media in
 *  this chat. Shared-wiki tagging — every member's gallery/viewer stays in
 *  sync without a refetch. */
export interface TagAddedPayload {
  mediaId: string;
  tag: import('./api.js').Tag;
}

/** Server → client (room broadcast), Stage 5: a tag was detached. */
export interface TagRemovedPayload {
  mediaId: string;
  tagId: string;
}

/** Server → client (room broadcast), Stage 3: a media message's processing
 *  finished (or failed) — updates the "processing" placeholder in place. The
 *  message id ties it back to the placeholder already in the client cache. */
export interface MediaReadyPayload {
  message: import('./api.js').Message;
}

/** Server → client (room broadcast), post-MVP: an embed card's provider
 *  resolution finished (or failed) — updates the "processing" placeholder in
 *  place. Identical pattern + reasoning to `MediaReadyPayload` (docs/EMBEDS.md
 *  §4.2/§4.3). */
export interface EmbedReadyPayload {
  message: import('./api.js').Message;
}

/** Server → client (room broadcast), Stage 6: these messages are gone for
 *  everyone. Ids only — the client already has the bodies and is removing
 *  them (§ docs/archive/MESSAGE_DELETE.md §2). Batched by design: a bulk delete of
 *  30 messages is one frame, not 30. */
export interface MessageDeletedPayload {
  chatId: string;
  messageIds: string[];
}

/** Server → client (room broadcast), Stage 6: an undo put these back.
 *  Carries FULL message objects, not ids — non-deleter clients dropped their
 *  copies on `message.deleted` and can't reconstruct them from an id alone
 *  without a refetch. */
export interface MessageRestoredPayload {
  chatId: string;
  messages: import('./api.js').Message[];
}

/** Server → client (room broadcast), post-MVP: a message's body was edited
 *  (docs/MESSAGE_EDIT.md). Carries the FULL updated `Message`, same reasoning
 *  as `MessageRestoredPayload` — lets clients replace the cached row wholesale
 *  with no partial-patch reconstruction. Only emitted on a real change (the
 *  route skips the broadcast for a no-op edit, same "no phantom WS frame"
 *  rule as delete). */
export interface MessageEditedPayload {
  chatId: string;
  message: import('./api.js').Message;
}

/** Server → client (room broadcast), post-MVP: someone reacted to a message.
 *  `userId` lets every client recompute `mine` locally without a refetch. */
export interface ReactionAddedPayload {
  chatId: string;
  messageId: string;
  emoji: string;
  userId: string;
}

/** Server → client (room broadcast), post-MVP: a reaction was removed. */
export interface ReactionRemovedPayload {
  chatId: string;
  messageId: string;
  emoji: string;
  userId: string;
}

// ─── receipts (post-MVP, docs/RECEIPTS.md) ──────────────────────────────────

/** Client → server: these messages reached this device (WS frame received,
 *  or newest ids seen in a refetch after reconnect). Batched: one frame can
 *  ack many chats. Invalid/non-member items are skipped silently — this is a
 *  fire-and-forget ack, never worth an Error-frame round trip. */
export interface DeliveredAckPayload {
  items: { chatId: string; messageId: string }[];
}

/** Server → chat room, only when `lastDeliveredMessageId` actually advanced
 *  (guarded-monotonic write — "no phantom frame" rule). */
export interface MessageDeliveredPayload {
  chatId: string;
  userId: string;
  messageId: string;
}

/** Server → chat room, only when `lastReadMessageId` actually advanced. */
export interface MessageReadPayload {
  chatId: string;
  userId: string;
  messageId: string;
}

/** Build a server→client envelope with a fresh timestamp. */
export function makeEnvelope<T extends string, P>(
  type: T,
  payload: P,
  reqId?: string,
): WsEnvelope<T, P> {
  return { type, payload, ts: Date.now(), ...(reqId ? { reqId } : {}) };
}
