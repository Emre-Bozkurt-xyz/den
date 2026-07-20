/**
 * Chats & message history (BACKBONE §2, §5, §6). Text sending itself happens
 * over WS (`message.send` in ws.ts) — these routes cover chat list/creation,
 * paginated history, and read receipts. Every route asserts membership
 * (CLAUDE.md hard invariant 1).
 */
import type { FastifyInstance } from 'fastify';
import { ChatLimits, WsType, makeEnvelope, type ChatsResponse, type CreateChatRequest, type MarkReadRequest, type MessagesResponse } from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { assertMember } from '../chat/membership.js';
import { createChat, getMessagesPage, listChatsForUser, markRead } from '../chat/service.js';
import { chatRoom, userRoom } from '../realtime/rooms.js';
import { validation } from '../errors.js';

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chats', { preHandler: requireAuth }, async (req) => {
    const res: ChatsResponse = { chats: await listChatsForUser(req.user!.id) };
    return res;
  });

  app.post<{ Body: CreateChatRequest }>('/chats', { preHandler: requireAuth }, async (req, reply) => {
    const result = await createChat(req.user!.id, req.body ?? { memberIds: [] });

    if (result.created) {
      // Join every member's live sockets — including the creator's own — to
      // the new chat room so message fanout works immediately, without
      // waiting for a reconnect. Missing the creator here means their own
      // sent messages never reach their own socket (broadcasts go to the
      // room, and their socket isn't in it yet), which stalls the optimistic
      // pending-bubble reconciliation in realtime.tsx until next reconnect.
      for (const memberId of [...result.newMemberIds, req.user!.id]) {
        const sockets = await app.io?.in(userRoom(memberId)).fetchSockets();
        for (const s of sockets ?? []) await s.join(chatRoom(result.chat.id));
      }
      for (const memberId of result.newMemberIds) {
        app.io?.to(userRoom(memberId)).emit('ws', makeEnvelope(WsType.ChatCreated, { chat: result.chat }));
      }
    }

    return reply.status(result.created ? 201 : 200).send(result.chat);
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>(
    '/chats/:id/messages',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);

      const before = req.query.before ? parseId(req.query.before) : null;
      const limit = clampLimit(req.query.limit);

      const res: MessagesResponse = await getMessagesPage(chatId, before, limit);
      return res;
    },
  );

  app.post<{ Params: { id: string }; Body: MarkReadRequest }>(
    '/chats/:id/read',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const messageId = req.body?.messageId ? parseId(req.body.messageId) : null;
      if (messageId === null) throw validation('messageId required');
      await markRead(chatId, req.user!.id, messageId);
      return { ok: true };
    },
  );
}

function parseId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid id');
  }
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : ChatLimits.messagesPageDefault;
  if (!Number.isFinite(n) || n <= 0) return ChatLimits.messagesPageDefault;
  return Math.min(n, ChatLimits.messagesPageMax);
}
