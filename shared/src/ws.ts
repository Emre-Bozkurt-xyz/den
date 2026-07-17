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
  // tags (Stage 5)
  TagAdded: 'tag.added',
  TagRemoved: 'tag.removed',
} as const;

export type WsTypeName = (typeof WsType)[keyof typeof WsType];

// ─── payload shapes (Stage 2) — keep in sync with the emitters/handlers ─────

/** Client → server: send a text message. Server validates chat membership,
 *  persists, then broadcasts `MessageNew` to the chat room (sender included) —
 *  the client reconciles its optimistic bubble via the envelope's `reqId`. */
export interface MessageSendPayload {
  chatId: string;
  body: string;
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

/** Build a server→client envelope with a fresh timestamp. */
export function makeEnvelope<T extends string, P>(
  type: T,
  payload: P,
  reqId?: string,
): WsEnvelope<T, P> {
  return { type, payload, ts: Date.now(), ...(reqId ? { reqId } : {}) };
}
