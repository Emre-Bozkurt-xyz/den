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
  // messaging (Stage 2)
  MessageSend: 'message.send',
  MessageNew: 'message.new',
  // media (Stage 3)
  MediaReady: 'media.ready',
  // tags (Stage 5)
  TagAdded: 'tag.added',
  TagRemoved: 'tag.removed',
} as const;

export type WsTypeName = (typeof WsType)[keyof typeof WsType];

/** Build a server→client envelope with a fresh timestamp. */
export function makeEnvelope<T extends string, P>(
  type: T,
  payload: P,
  reqId?: string,
): WsEnvelope<T, P> {
  return { type, payload, ts: Date.now(), ...(reqId ? { reqId } : {}) };
}
