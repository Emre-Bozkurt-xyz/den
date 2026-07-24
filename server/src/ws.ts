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
 * A socket joins its own `user:` room plus a `chat:` room per chat it's
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
  type WsEnvelope,
  type DeliveredAckPayload,
  type MessageSendPayload,
  type Message as MessageDto,
} from '@den/shared';
import { env } from './env.js';
import { db } from './db/index.js';
import { chatMembers, sessions } from './db/schema.js';
import { SESSION_COOKIE } from './auth/session.js';
import { assertMember, isMember } from './chat/membership.js';
import { markDelivered, sendTextMessage } from './chat/service.js';
import { createEmbedMessage, finalizeEmbed } from './embeds/service.js';
import { notifyChatMembers } from './push/notify.js';
import { AppError } from './errors.js';
import { chatRoom, userRoom } from './realtime/rooms.js';

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
    .select({ userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, token))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return row.userId;
}

async function joinOwnChatRooms(socket: Socket, userId: bigint): Promise<void> {
  const rows = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId));
  for (const r of rows) await socket.join(chatRoom(r.chatId));
}

export function attachWs(app: FastifyInstance): IOServer {
  const io = new IOServer(app.server, {
    // Same-origin in production; allow the Vite dev origin in dev.
    cors: env.isProd ? undefined : { origin: true, credentials: true },
    pingInterval: 25_000, // proxies kill idle sockets (BACKBONE §8)
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    const token = readSessionToken(socket.handshake.headers.cookie);
    if (!token) return next(new Error('unauthorized'));
    userIdForToken(token)
      .then((userId) => {
        if (!userId) return next(new Error('unauthorized'));
        socket.data.userId = userId;
        next();
      })
      .catch(next);
  });

  io.on('connection', (socket) => {
    // socket.io's SocketData defaults to `any`; set in the io.use auth
    // middleware above, always a bigint by the time `connection` fires.
    const userId = socket.data.userId as bigint;
    void socket.join(userRoom(userId));
    void joinOwnChatRooms(socket, userId);

    socket.emit('ws', makeEnvelope(WsType.Hello, { hello: 'den', socketId: socket.id }));

    socket.on('ws', (frame: WsEnvelope) => {
      if (!frame || typeof frame.type !== 'string') return;
      // Guard the reserved call.* prefixes — MVP must never accept them.
      if (isReservedWsType(frame.type)) return;

      switch (frame.type) {
        case WsType.Ping:
          socket.emit('ws', makeEnvelope(WsType.Pong, {}, frame.reqId));
          break;
        case WsType.MessageSend:
          void handleMessageSend(io, socket, userId, frame as WsEnvelope<string, MessageSendPayload>);
          break;
        case WsType.DeliveredAck:
          void handleDeliveredAck(io, userId, frame as WsEnvelope<string, DeliveredAckPayload>);
          break;
        default:
          // Unknown types are ignored — real handlers land per-stage.
          break;
      }
    });
  });

  app.decorate('io', io);
  return io;
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

    let message: MessageDto;
    let embedId: bigint | null = null;
    if (detected) {
      const caption = stripEmbedUrl(rawBody, detected);
      const created = await createEmbedMessage(chatId, userId, detected.provider, detected.url, detected.providerRef, caption, replyToId);
      message = created.message;
      embedId = created.embedId;
    } else {
      message = await sendTextMessage(chatId, userId, rawBody, replyToId);
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
    const code = e instanceof AppError ? e.code : 'internal';
    const message = e instanceof Error ? e.message : 'failed to send message';
    socket.emit('ws', makeEnvelope(WsType.Error, { code, message }, frame.reqId));
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
