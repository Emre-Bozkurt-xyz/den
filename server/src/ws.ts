/**
 * Realtime layer (socket.io). Every frame uses the LOCKED `WsEnvelope` from
 * @den/shared on a single 'ws' event — no second envelope, ever (hard
 * invariant 4).
 *
 * Auth: the session cookie is read directly off the handshake headers (no
 * Fastify request in scope here) and resolved against the `sessions` table —
 * the same unsigned token `auth/session.ts` sets. Unauthenticated handshakes
 * are rejected before `connection` fires.
 *
 * Rooms:
 *   - `user:{id}`  — one user, all their tabs/devices; used for notices that
 *                    aren't chat-scoped yet (chat.created, friend.*).
 *   - `chat:{id}`  — every member of that chat; message fanout target.
 *   - `session:{hash}` — every socket opened with one session cookie; what
 *                    logout / per-session revoke disconnect (realtime/revoke.ts).
 * A socket joins its own `user:` and `session:` rooms plus a `chat:` room per chat it's
 * already a member of on connect. When a *new* chat is created, the route
 * handler explicitly joins the new members' sockets so fanout works without
 * requiring a reconnect.
 *
 * Reconnect semantics (BACKBONE §8): the client refetches on reconnect — this
 * server never replays missed frames, so there's no backlog/at-least-once
 * bookkeeping here.
 */
import type { FastifyInstance } from 'fastify';
import { Server as IOServer, type Socket } from 'socket.io';
import { eq } from 'drizzle-orm';
import {
  WsType,
  makeEnvelope,
  isReservedWsType,
  detectEmbedUrl,
  stripEmbedUrl,
  ErrorCode,
  type WsEnvelope,
  type DeliveredAckPayload,
  type MessageSendPayload,
  type PresenceUpdatePayload,
  type TypingUpdatePayload,
  type Message as MessageDto,
} from '@den/shared';
import { env, gifsEnabled } from './env.js';
import { db } from './db/index.js';
import { chatMembers, sessions, users } from './db/schema.js';
import { SESSION_COOKIE } from './auth/session.js';
import { assertMember, isMember } from './chat/membership.js';
import {
  claimClientNonce,
  discardDuplicateSend,
  markDelivered,
  messageByClientNonce,
  parseClientNonce,
  sendTextMessage,
} from './chat/service.js';
import { createEmbedMessage, finalizeEmbed } from './embeds/service.js';
import { notifyChatMembers } from './push/notify.js';
import { AppError, unavailable } from './errors.js';
import { isValidGifSlug } from './gifs/klipy.js';
import { aspectHint } from './aspectHint.js';
import { chatRoom, sessionRoom, userRoom } from './realtime/rooms.js';
import { clearSocket, clearTyping, setTyping } from './realtime/typing.js';
import { startSessionRecheck } from './realtime/revoke.js';
import { TokenBucket } from './realtime/tokenBucket.js';
import { originAllowed } from './auth/originCheck.js';

declare module 'fastify' {
  interface FastifyInstance {
    io: IOServer;
  }
}

function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const name = part.slice(0, eqIdx).trim();
    if (name === SESSION_COOKIE) return decodeURIComponent(part.slice(eqIdx + 1).trim());
  }
  return null;
}

async function userIdForToken(token: string): Promise<bigint | null> {
  const rows = await db
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt, disabledAt: users.disabledAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, token))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  // Same rule as resolveSession (auth/session.ts): a disabled account's
  // sessions resolve to nothing, even if a row survived the disable.
  if (row.disabledAt) return null;
  return row.userId;
}

async function joinOwnChatRooms(socket: Socket, userId: bigint): Promise<void> {
  const rows = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId));
  for (const r of rows) await socket.join(chatRoom(r.chatId));
}

/**
 * Run a fire-and-forget async path with its rejection caught and logged.
 *
 * ⚠️ Every `void someAsync()` in this file used to be a bare `void`, so one
 * transient DB error in a delivered-ack or presence lookup became an
 * unhandled rejection — which kills the Node process and with it every
 * connected socket in the circle. A frame handler failing must cost that one
 * frame, never the server.
 */
function guard(label: string, work: Promise<unknown>): void {
  work.catch((err) => console.error(`ws ${label} failed:`, err instanceof Error ? err.message : err));
}

/**
 * Inbound frame budget, per socket (realtime/tokenBucket.ts).
 *
 * Without one, a member — or anyone holding a stolen session — could flood
 * `message.send` (each one a DB write plus a push to every other member's
 * phone) or `typing.update` as fast as the socket carried them. Sized so a
 * real person in an active group never notices:
 *   - all frames: burst 100, then 20/s. Opening the app sends one delivered
 *     ack per chat-list refresh, a presence report and a few typing frames;
 *     a busy group adds one ack per incoming message.
 *   - message.send: burst 30, then 1/s sustained. Thirty rapid-fire messages
 *     back to back, then one a second for as long as you like.
 * A refused frame gets a WS error frame — the socket stays up. Disconnecting
 * would make the client reconnect and resync, which costs the server more
 * than the frames it was refusing.
 */
const FRAME_BUCKET = { capacity: 100, refillPerSecond: 20 } as const;
const SEND_BUCKET = { capacity: 30, refillPerSecond: 1 } as const;
/** Refusals of fire-and-forget frames (no reqId) are reported at most this
 *  often, so a flood is not answered with a flood. */
const RATE_NOTICE_INTERVAL_MS = 10_000;

export function attachWs(app: FastifyInstance): IOServer {
  const io = new IOServer(app.server, {
    // Same-origin in production; allow the Vite dev origin in dev.
    cors: env.isProd ? undefined : { origin: true, credentials: true },
    pingInterval: 25_000, // proxies kill idle sockets (BACKBONE §8)
    pingTimeout: 20_000,
    // Same-site forgery guard for the handshake (auth/originCheck.ts). With
    // `cors` off, nothing else checks Origin on a WebSocket upgrade, and a
    // page on a sibling subdomain is same-site — its handshake carries the
    // SameSite=Lax cookie and would get a fully authenticated socket.
    allowRequest: (req, callback) => {
      const ok = originAllowed(req.headers.origin, { isProd: env.isProd, publicOrigin: env.publicOrigin });
      if (!ok) app.log.warn({ origin: req.headers.origin }, 'refused cross-origin socket handshake');
      callback(null, ok);
    },
  });

  io.use((socket, next) => {
    const token = readSessionToken(socket.handshake.headers.cookie);
    if (!token) return next(new Error('unauthorized'));
    userIdForToken(token)
      .then((userId) => {
        if (!userId) return next(new Error('unauthorized'));
        socket.data.userId = userId;
        // Recorded so the session can be revoked out from under this socket
        // (realtime/revoke.ts). Kept only in process memory, like the cookie
        // header socket.io already holds for the handshake.
        socket.data.sessionToken = token;
        next();
      })
      .catch((err) => {
        // ⚠️ Never `next(err)` with the raw error: socket.io sends the
        // message to the client, and a Postgres error message carries SQL.
        console.error('ws handshake session lookup failed:', err instanceof Error ? err.message : err);
        next(new Error('unavailable'));
      });
  });

  // Defence in depth behind the explicit disconnects in the routes that end
  // sessions: re-validate every live socket's session on a coarse interval.
  startSessionRecheck(io);

  io.on('connection', (socket) => {
    // socket.io's SocketData defaults to `any`; set in the io.use auth
    // middleware above, always a bigint by the time `connection` fires.
    const userId = socket.data.userId as bigint;
    void socket.join(userRoom(userId));
    void socket.join(sessionRoom(socket.data.sessionToken as string));
    // A socket that silently failed to join its chat rooms would look
    // connected and receive nothing. Closing the TRANSPORT (not
    // `socket.disconnect()`, which the client treats as final) makes the
    // client's own reconnect loop retry, and its reconnect handler resyncs.
    joinOwnChatRooms(socket, userId).catch((err) => {
      console.error('ws join chat rooms failed:', err instanceof Error ? err.message : err);
      socket.conn.close();
    });

    socket.emit('ws', makeEnvelope(WsType.Hello, { hello: 'den', socketId: socket.id }));

    const frameBucket = new TokenBucket(FRAME_BUCKET.capacity, FRAME_BUCKET.refillPerSecond);
    const sendBucket = new TokenBucket(SEND_BUCKET.capacity, SEND_BUCKET.refillPerSecond);
    let lastRateNoticeAt = 0;
    const refuseRateLimited = (frame: WsEnvelope): void => {
      // A send carries a reqId and the client is waiting on it (the bubble
      // flips to "failed", retryable) — always answer that one.
      if (frame.type === WsType.MessageSend && frame.reqId) {
        socket.emit('ws', makeEnvelope(WsType.Error, { code: ErrorCode.RateLimited, message: 'Slow down' }, frame.reqId));
        return;
      }
      const now = Date.now();
      if (now - lastRateNoticeAt < RATE_NOTICE_INTERVAL_MS) return;
      lastRateNoticeAt = now;
      socket.emit('ws', makeEnvelope(WsType.Error, { code: ErrorCode.RateLimited, message: 'Slow down' }));
    };

    socket.on('ws', (frame: WsEnvelope) => {
      // A synchronous throw out of an event listener would escape socket.io's
      // packet handling as an uncaught exception — same fate as an unhandled
      // rejection. Async handlers are covered by `guard`.
      try {
        if (!frame || typeof frame.type !== 'string') return;
        // Guard the reserved call.* prefixes — MVP must never accept them.
        if (isReservedWsType(frame.type)) return;

        if (!frameBucket.take() || (frame.type === WsType.MessageSend && !sendBucket.take())) {
          refuseRateLimited(frame);
          return;
        }

        switch (frame.type) {
          case WsType.Ping:
            socket.emit('ws', makeEnvelope(WsType.Pong, {}, frame.reqId));
            break;
          case WsType.MessageSend:
            guard('message.send', handleMessageSend(io, socket, userId, frame as WsEnvelope<string, MessageSendPayload>));
            break;
          case WsType.DeliveredAck:
            guard('delivered.ack', handleDeliveredAck(io, userId, frame as WsEnvelope<string, DeliveredAckPayload>));
            break;
          case WsType.PresenceUpdate:
            guard('presence.update', handlePresenceUpdate(socket, userId, frame as WsEnvelope<string, PresenceUpdatePayload>));
            break;
          case WsType.TypingUpdate:
            guard('typing.update', handleTypingUpdate(socket, userId, frame as WsEnvelope<string, TypingUpdatePayload>));
            break;
          default:
            // Unknown types are ignored — real handlers land per-stage.
            break;
        }
      } catch (err) {
        console.error('ws frame dispatch failed:', err instanceof Error ? err.message : err);
      }
    });

    // ⚠️ Announce the stops on disconnect (docs/TYPING_INDICATORS.md §2,
    // defence #2). Without this a clean tab close leaves "X is typing…" up
    // for everyone until the server-side expiry fires — correct eventually,
    // but visibly wrong for six seconds every single time someone closes the
    // app mid-word, which is often.
    socket.on('disconnect', () => {
      for (const chatId of clearSocket(socket.id)) {
        emitTypingState(socket, chatId, userId, false);
      }
    });
  });

  app.decorate('io', io);
  return io;
}


/**
 * Fan a typing state to the chat room, **excluding the socket it came from**.
 *
 * ⚠️ `socket.to(room)`, never `io.to(room)`. The difference is not just wasted
 * traffic: the client keys typers by userId and resolves names from
 * `chat.members`, so an echo back to the sender renders as *"You are typing…"*
 * on your own screen. Written with `io.to()` first and caught by
 * scripts/probe-typing.ts §1, which is exactly the check that exists for it.
 *
 * Also correct on the expiry and disconnect paths: the socket is gone by then,
 * so excluding it is a no-op, and the person who was typing has no use for
 * their own stop either.
 */
function emitTypingState(socket: Socket, chatId: string, userId: bigint, typing: boolean): void {
  socket.to(chatRoom(BigInt(chatId))).emit(
    'ws',
    makeEnvelope(WsType.TypingState, { chatId, userId: userId.toString(), typing }),
  );
}

/**
 * Client → server typing state (docs/TYPING_INDICATORS.md §1).
 *
 * ⚠️ `assertMember` is not optional here. `chatId` arrives from the client, so
 * without it anyone could both broadcast into and — via the echo — learn about
 * activity in a chat they are not part of. Hard invariant 1 governs WS frames
 * exactly as it governs REST routes.
 *
 * Broadcasts only on an actual *transition*. The client refreshes every ~3s
 * while someone keeps typing, and re-fanning that to every member each time
 * would turn a cosmetic feature into steady per-member traffic for no added
 * information.
 */
async function handleTypingUpdate(
  socket: Socket,
  userId: bigint,
  frame: WsEnvelope<string, TypingUpdatePayload>,
): Promise<void> {
  const payload = frame.payload;
  const rawChatId = typeof payload?.chatId === 'string' ? payload.chatId : null;
  if (!rawChatId) return;

  let chatId: bigint;
  try {
    chatId = BigInt(rawChatId);
  } catch {
    return; // garbage id — ignore silently, same as a malformed presence claim
  }

  try {
    await assertMember(userId, chatId);
  } catch {
    return; // not a member: no echo, no error frame, nothing to learn from
  }

  const key = chatId.toString();
  if (payload?.typing === true) {
    // The expiry callback is the server announcing the stop on behalf of a
    // client that may no longer exist — the defence that does not depend on
    // anyone being alive to send `typing: false`.
    const isNew = setTyping(socket.id, key, () => emitTypingState(socket, key, userId, false));
    if (isNew) emitTypingState(socket, key, userId, true);
  } else {
    const had = clearTyping(socket.id, key);
    if (had) emitTypingState(socket, key, userId, false);
  }
}

async function handleMessageSend(
  io: IOServer,
  socket: Socket,
  userId: bigint,
  frame: WsEnvelope<string, MessageSendPayload>,
): Promise<void> {
  try {
    const chatIdRaw = frame.payload?.chatId;
    if (typeof chatIdRaw !== 'string') throw new AppError(400, 'validation', 'chatId required');
    let chatId: bigint;
    try {
      chatId = BigInt(chatIdRaw);
    } catch {
      throw new AppError(400, 'validation', 'invalid chatId');
    }

    await assertMember(userId, chatId);

    // Idempotent sends (chat/service.ts, PROJECT.md §14 2026-11-18): the
    // frame's reqId is persisted as the message's client nonce. A frame whose
    // nonce already has a row is a retry of a send that DID land (its ack was
    // lost): ack THIS socket with the existing message and stop — no second
    // room broadcast, no second push, no second embed resolve. Checked before
    // any other validation so a retry is answered even if, say, its reply
    // target has since been deleted.
    const clientNonce = parseClientNonce(frame.reqId);
    const ackExisting = (existing: MessageDto): void => {
      socket.emit('ws', makeEnvelope(WsType.MessageNew, { message: existing }, frame.reqId));
    };
    if (clientNonce) {
      const existing = await messageByClientNonce(chatId, userId, clientNonce);
      if (existing) return ackExisting(existing);
    }

    let replyToId: bigint | undefined;
    const replyToIdRaw = frame.payload?.replyToId;
    if (typeof replyToIdRaw === 'string' && replyToIdRaw) {
      try {
        replyToId = BigInt(replyToIdRaw);
      } catch {
        throw new AppError(400, 'validation', 'invalid replyToId');
      }
    }

    // docs/EMBEDS.md §4.3: server-side sniff of the raw body for a recognized
    // embeddable URL (shared/src/embeds.ts, same detector the composer's
    // paste-detect chip uses) — a match mints an embed message instead of a
    // plain text one. Any words left after stripping the URL become the
    // caption (its own bubble under the bare card, like a media caption).
    const rawBody = frame.payload?.body ?? '';
    const detected = detectEmbedUrl(rawBody);

    // docs/GIFS.md §6 — the "client sets an intent" half of the same mint
    // path, designed in docs/EMBEDS.md §4.3 and unused until GIFs. Checked
    // BEFORE body-sniffing: an intent is explicit, so it wins outright rather
    // than racing a detector over text that must be empty anyway.
    const gifIntent = frame.payload?.gif;

    let message: MessageDto;
    let embedId: bigint | null = null;
    if (gifIntent !== undefined) {
      if (!gifsEnabled) throw unavailable('GIF sending is not configured');
      if (!isValidGifSlug(gifIntent?.slug)) throw new AppError(400, ErrorCode.Validation, 'invalid gif slug');
      // A GIF has no caption (D4). Refusing beats silently discarding text the
      // user typed — and no client of ours can produce this combination.
      if (rawBody.trim()) throw new AppError(400, ErrorCode.Validation, 'a GIF message cannot have a body');
      // `url` is null: only the slug is known here, and the resolver decides
      // whether there is any canonical link at all. The placeholder is shaped
      // now so other members don't watch a generic box pop into a GIF a second
      // later — `contentKind`/`actionType` are facts the server knows (this
      // frame IS a GIF pick), the dimensions are a clamped cosmetic hint.
      const created = await createEmbedMessage(chatId, userId, 'klipy', null, gifIntent.slug, null, replyToId, {
        contentKind: 'gif',
        actionType: 'inline',
        data: aspectHint(gifIntent.width, gifIntent.height),
      });
      message = created.message;
      embedId = created.embedId;
    } else if (detected) {
      const caption = stripEmbedUrl(rawBody, detected);
      const created = await createEmbedMessage(chatId, userId, detected.provider, detected.url, detected.providerRef, caption, replyToId);
      message = created.message;
      embedId = created.embedId;
    } else {
      // Two frames with one nonce in flight at once: the insert's ON CONFLICT
      // hands the loser the winner's row.
      const sent = await sendTextMessage(chatId, userId, rawBody, replyToId, clientNonce);
      if (sent.duplicate) return ackExisting(sent.message);
      message = sent.message;
    }

    // The embed insert (embeds/service.ts) doesn't take the nonce, so stamp it
    // here — before anyone has heard of the row, so the loser of a concurrent
    // duplicate can still be discarded unseen.
    if (embedId !== null && clientNonce && !(await claimClientNonce(BigInt(message.id), clientNonce))) {
      await discardDuplicateSend(BigInt(message.id));
      const existing = await messageByClientNonce(chatId, userId, clientNonce);
      if (existing) ackExisting(existing);
      return;
    }

    // Placeholder fanout now (mirrors media/routes.ts's upload-complete
    // step) — receivers see a "processing" card immediately, not silence.
    io.to(chatRoom(chatId)).emit('ws', makeEnvelope(WsType.MessageNew, { message }, frame.reqId));
    void notifyChatMembers(io, chatId, message);

    // Resolve in the background; don't make the sender's send wait on an
    // outbound fetch to a third-party host. embed.ready follows.
    if (embedId !== null) {
      const resolvingEmbedId = embedId;
      void finalizeEmbed(resolvingEmbedId)
        .then((updated) => {
          io.to(chatRoom(chatId)).emit('ws', makeEnvelope(WsType.EmbedReady, { message: updated }));
        })
        .catch((err) =>
          console.error(`embed finalize failed for embed ${resolvingEmbedId}:`, err instanceof Error ? err.message : err),
        );
    }
  } catch (e) {
    // ⚠️ Only the app's own errors are forwarded verbatim — same rule as the
    // REST error handler (app.ts). Anything else (a Drizzle/Postgres error
    // embeds the SQL and its parameters in `message`) is logged here and the
    // client gets a generic string; it branches on `code` anyway.
    if (e instanceof AppError) {
      socket.emit('ws', makeEnvelope(WsType.Error, { code: e.code, message: e.message }, frame.reqId));
      return;
    }
    console.error('message.send failed:', e instanceof Error ? e.message : e);
    socket.emit(
      'ws',
      makeEnvelope(WsType.Error, { code: ErrorCode.Internal, message: 'Failed to send message' }, frame.reqId),
    );
  }
}

// Batch ceiling for a single delivered.ack frame (docs/RECEIPTS.md §4.5) —
// generous enough for a full chat-list reconnect ack, cheap enough that a
// malicious/buggy client can't turn one frame into an unbounded DB hammer.
const DELIVERED_ACK_BATCH_MAX = 50;

/** Client → server delivery ack (docs/RECEIPTS.md §4.5): fire-and-forget,
 *  batched across chats. Every item is validated independently and bad ones
 *  are skipped silently — no Error-frame spam for what's just a hint, and no
 *  membership leak via a non-member item's error message. No reply frame on
 *  success (unlike message.send, nothing here needs reqId correlation). */
async function handleDeliveredAck(
  io: IOServer,
  userId: bigint,
  frame: WsEnvelope<string, DeliveredAckPayload>,
): Promise<void> {
  const items = Array.isArray(frame.payload?.items) ? frame.payload.items.slice(0, DELIVERED_ACK_BATCH_MAX) : [];

  for (const item of items) {
    if (!item || typeof item.chatId !== 'string' || typeof item.messageId !== 'string') continue;
    let chatId: bigint;
    let messageId: bigint;
    try {
      chatId = BigInt(item.chatId);
      messageId = BigInt(item.messageId);
    } catch {
      continue; // garbage id — skip, not worth an Error frame
    }

    if (!(await isMember(userId, chatId))) continue; // non-member: skip silently, nothing leaks

    try {
      const advanced = await markDelivered(chatId, userId, messageId);
      if (advanced) {
        io.to(chatRoom(chatId)).emit(
          'ws',
          makeEnvelope(WsType.MessageDelivered, {
            chatId: chatId.toString(),
            userId: userId.toString(),
            messageId: messageId.toString(),
          }),
        );
      }
    } catch {
      // Foreign/garbage message id (markDelivered's messageExistsInChat
      // guard) — skip this item, same fire-and-forget posture as above.
    }
  }
}

/**
 * `presence.update` — the socket tells us which chat it is actually looking
 * at (docs/NOTIFICATIONS.md §2.1). Stored on `socket.data`, read only by
 * `push/notify.ts`, never echoed anywhere: no other user can observe it and
 * nothing is sent back.
 *
 * Membership-gated (hard invariant 1) even though a false claim leaks
 * nothing — `notifyChatMembers` only consults presence for users who are
 * already members, so the worst a spoofed chatId could do is silence a push
 * for a chat that would never have targeted the spoofer anyway. One indexed
 * lookup per chat switch is cheap insurance against that reasoning going
 * stale, and presence updates are rare by construction (chat open/close and
 * visibility edges, not keystrokes).
 *
 * A rejected or malformed claim clears presence rather than leaving the
 * previous one standing — stale presence suppresses notifications, which is
 * the failure this whole pass exists to remove.
 */
async function handlePresenceUpdate(
  socket: Socket,
  userId: bigint,
  frame: WsEnvelope<string, PresenceUpdatePayload>,
): Promise<void> {
  const payload = frame.payload;
  const visible = payload?.visible === true;
  const rawChatId = typeof payload?.chatId === 'string' ? payload.chatId : null;

  // The membership check below is the only `await` here, and it is enough to
  // let two frames land out of order — switch chats fast enough and the slower
  // lookup for the chat you LEFT could resolve last and overwrite the one you
  // are on. That writes a report which is not merely stale but wrong, and a
  // wrong report suppresses a notification. So every frame takes a sequence
  // number on arrival and drops its own result if a newer one has since landed.
  const seq = ((socket.data.presenceSeq as number | undefined) ?? 0) + 1;
  socket.data.presenceSeq = seq;
  const isNewest = (): boolean => socket.data.presenceSeq === seq;

  let chatId: bigint | null = null;
  if (rawChatId !== null) {
    try {
      chatId = BigInt(rawChatId);
    } catch {
      chatId = null; // garbage id — same treatment as "no chat", never a stale claim
    }
  }

  if (chatId === null) {
    socket.data.presence = { chatId: null, visible };
    return;
  }

  const member = await isMember(userId, chatId);
  if (!isNewest()) return;
  socket.data.presence = { chatId: member ? rawChatId : null, visible };
}
