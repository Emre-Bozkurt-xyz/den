/**
 * Chats & message history (BACKBONE §2, §5, §6). Text sending itself happens
 * over WS (`message.send` in ws.ts) — these routes cover chat list/creation,
 * paginated history, and read receipts. Every route asserts membership
 * (CLAUDE.md hard invariant 1).
 */
import type { FastifyInstance } from 'fastify';
import {
  ChatLimits,
  WsType,
  makeEnvelope,
  type ChatsResponse,
  type CreateChatRequest,
  type MarkReadRequest,
  type Message as MessageDto,
  type MessageIdsRequest,
  type MessagesResponse,
  type ReactRequest,
  type SearchMessagesQuery,
  type SearchMessagesResponse,
} from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { assertMember } from '../chat/membership.js';
import {
  createChat,
  getMessagesPage,
  listChatsForUser,
  markRead,
  restoreMessages,
  searchMessages,
  softDeleteMessages,
  type SearchFilters,
} from '../chat/service.js';
import { addReaction, removeReaction } from '../chat/reactions.js';
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

      const res: MessagesResponse = await getMessagesPage(chatId, before, limit, req.user!.id);
      return res;
    },
  );

  // Per-chat message search (docs/MESSAGE_SEARCH.md). Same auth shape as the
  // plain history route above: assertMember before touching anything (hard
  // invariant 1) — search must never widen visibility across chats.
  app.get<{ Params: { id: string }; Querystring: SearchMessagesQuery }>(
    '/chats/:id/messages/search',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);

      const filters = parseSearchFilters(req.query);
      const before = req.query.before ? parseId(req.query.before) : null;
      const limit = clampSearchLimit(req.query.limit);

      const res: SearchMessagesResponse = await searchMessages(chatId, filters, before, limit, req.user!.id);
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

  // Own-messages-only soft delete + undo (Stage 6 / §2 item 11). `POST`-with-
  // body rather than `DELETE`-with-body, matching the `/read` convention
  // above. Membership + ownership are enforced inside softDeleteMessages/
  // restoreMessages (chat/service.ts) — mixed/invalid batches are rejected
  // whole with 403, writing nothing (docs/archive/MESSAGE_DELETE.md §3).
  app.post<{ Params: { id: string }; Body: MessageIdsRequest }>(
    '/chats/:id/messages/delete',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      const messageIds = await softDeleteMessages(req.user!.id, chatId, req.body?.messageIds ?? []);

      // Skip the broadcast entirely when nothing actually changed (e.g. a
      // retried delete of already-deleted ids) — no phantom WS frame.
      if (messageIds.length > 0) {
        app.io
          ?.to(chatRoom(chatId))
          .emit('ws', makeEnvelope(WsType.MessageDeleted, { chatId: chatId.toString(), messageIds }));
      }
      return { messageIds };
    },
  );

  app.post<{ Params: { id: string }; Body: MessageIdsRequest }>(
    '/chats/:id/messages/restore',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      const restored: MessageDto[] = await restoreMessages(req.user!.id, chatId, req.body?.messageIds ?? []);

      if (restored.length > 0) {
        app.io
          ?.to(chatRoom(chatId))
          .emit('ws', makeEnvelope(WsType.MessageRestored, { chatId: chatId.toString(), messages: restored }));
      }
      return { messages: restored };
    },
  );

  // Reactions (post-MVP). Membership is asserted before touching anything
  // (CLAUDE.md hard invariant 1); add/remove are separate idempotent verbs,
  // not a toggle — see ReactRequest in @den/shared.
  app.post<{ Params: { id: string; messageId: string }; Body: ReactRequest }>(
    '/chats/:id/messages/:messageId/reactions',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const messageId = parseId(req.params.messageId);
      const rawEmoji = req.body?.emoji;
      if (typeof rawEmoji !== 'string') throw validation('emoji required');
      const emoji = rawEmoji.trim();

      await addReaction(chatId, messageId, req.user!.id, emoji);

      app.io?.to(chatRoom(chatId)).emit(
        'ws',
        makeEnvelope(WsType.ReactionAdded, {
          chatId: chatId.toString(),
          messageId: messageId.toString(),
          emoji,
          userId: req.user!.id.toString(),
        }),
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; messageId: string; emoji: string } }>(
    '/chats/:id/messages/:messageId/reactions/:emoji',
    { preHandler: requireAuth },
    async (req) => {
      const chatId = parseId(req.params.id);
      await assertMember(req.user!.id, chatId);
      const messageId = parseId(req.params.messageId);
      const emoji = decodeURIComponent(req.params.emoji);

      await removeReaction(chatId, messageId, req.user!.id, emoji);

      app.io?.to(chatRoom(chatId)).emit(
        'ws',
        makeEnvelope(WsType.ReactionRemoved, {
          chatId: chatId.toString(),
          messageId: messageId.toString(),
          emoji,
          userId: req.user!.id.toString(),
        }),
      );
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

function clampSearchLimit(raw: string | undefined): number {
  const n = raw ? Number(raw) : ChatLimits.searchPageDefault;
  if (!Number.isFinite(n) || n <= 0) return ChatLimits.searchPageDefault;
  return Math.min(n, ChatLimits.searchPageMax);
}

/** Parses a `since`/`until` querystring value (a bare `YYYY-MM-DD` date, no
 *  time component — docs/MESSAGE_SEARCH.md §3.3 "keep it simple and document
 *  it") into its UTC start-of-day instant. */
function parseDateOnly(raw: string, label: 'since' | 'until'): Date {
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw validation(`invalid ${label} date`);
  return d;
}

/** Validates the search querystring (docs/MESSAGE_SEARCH.md §3.3): at least
 *  one of q/from/since/until required, `q` trimmed and length-capped, `from`
 *  must parse as an id, dates must parse, and `since` can't be after
 *  `until`. */
function parseSearchFilters(query: SearchMessagesQuery): SearchFilters {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const from = query.from ? parseId(query.from) : null;
  const since = query.since ? parseDateOnly(query.since, 'since') : null;
  const until = query.until ? parseDateOnly(query.until, 'until') : null;

  if (!q && from === null && since === null && until === null) throw validation('empty search');
  if (q.length > ChatLimits.searchQueryMax) {
    throw validation(`search text too long (max ${ChatLimits.searchQueryMax} characters)`);
  }
  if (since !== null && until !== null && since.getTime() > until.getTime()) {
    throw validation('since must not be after until');
  }

  return { q: q || null, from, since, until };
}
