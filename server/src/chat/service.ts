/**
 * Chat/message business logic shared by the REST routes (chats.ts) and the WS
 * handler (ws.ts message.send). Keeps DB access in one place; callers own the
 * realtime side effects (WS fanout, push) since those differ per entry point.
 */
import { and, desc, eq, gt, gte, ilike, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  ChatLimits,
  type ChatSummary,
  type CreateChatRequest,
  type Message as MessageDto,
  type MessagesResponse,
  type SearchMessagesResponse,
} from '@den/shared';
import { db } from '../db/index.js';
import { chatMembers, chats, messages, users } from '../db/schema.js';
import { toChatSummary, toMessage, type ChatRow, type UserRow } from '../mappers.js';
import { forbidden, notFound, validation } from '../errors.js';
import { areFriends, pair } from './friends.js';
import { assertMember } from './membership.js';
import { mediaInfoForMessages } from '../media/service.js';
import { reactionsForMessages } from './reactions.js';
import { assertReplyTarget, replyPreviewFor, replyPreviewsForMessages } from './replies.js';

async function usersByIds(ids: bigint[]): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: users.id, username: users.username, displayName: users.displayName, avatarKey: users.avatarKey })
    .from(users)
    .where(inArray(users.id, ids));
}

async function memberIdsOf(chatId: bigint): Promise<bigint[]> {
  const rows = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chatId));
  return rows.map((r) => r.userId);
}

async function lastMessageOf(chatId: bigint): Promise<MessageDto | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNull(messages.deletedAt)))
    .orderBy(desc(messages.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Single-row reads (media + reply preview) are cheap here — a chat-list
  // preview is one row, not a page, so batching would be overkill. Reactions
  // stay [] for the preview (chat-list rows don't render reaction chips).
  const [mediaMap, replyTo] = await Promise.all([
    mediaInfoForMessages([row.id]),
    replyPreviewFor(row.replyToMessageId),
  ]);
  return toMessage(row, mediaMap.get(row.id.toString()) ?? null, replyTo, []);
}

async function unreadCountFor(chatId: bigint, viewerId: bigint, lastReadId: bigint | null): Promise<number> {
  const conditions = [eq(messages.chatId, chatId), isNull(messages.deletedAt), ne(messages.senderId, viewerId)];
  if (lastReadId !== null) conditions.push(gt(messages.id, lastReadId));
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(...conditions));
  return rows[0]?.count ?? 0;
}

async function buildSummary(chat: ChatRow, viewerId: bigint, lastReadId: bigint | null): Promise<ChatSummary> {
  const memberIds = await memberIdsOf(chat.id);
  const [memberRows, last, unread] = await Promise.all([
    usersByIds(memberIds),
    lastMessageOf(chat.id),
    unreadCountFor(chat.id, viewerId, lastReadId),
  ]);
  return toChatSummary({ chat, members: memberRows, lastMessage: last, unreadCount: unread });
}

export async function listChatsForUser(userId: bigint): Promise<ChatSummary[]> {
  const memberships = await db
    .select({ chatId: chatMembers.chatId, lastRead: chatMembers.lastReadMessageId })
    .from(chatMembers)
    .where(eq(chatMembers.userId, userId));
  if (memberships.length === 0) return [];

  const chatRows = await db.select().from(chats).where(inArray(chats.id, memberships.map((m) => m.chatId)));
  const lastReadByChat = new Map(memberships.map((m) => [m.chatId.toString(), m.lastRead]));

  const summaries = await Promise.all(
    chatRows.map((c) => buildSummary(c, userId, lastReadByChat.get(c.id.toString()) ?? null)),
  );
  // Most recent activity first (last message, falling back to chat creation).
  summaries.sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt).localeCompare(a.lastMessage?.createdAt ?? a.createdAt));
  return summaries;
}

function parseUserId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid member id');
  }
}

export interface CreateChatResult {
  chat: ChatSummary;
  /** True when a new chat row was created (false = an existing DM was returned). */
  created: boolean;
  /** Members other than the creator — used by the route to fan out chat.created. */
  newMemberIds: bigint[];
}

/** POST /chats. 1 memberId ⇒ DM (idempotent: returns the existing DM if one
 *  exists); 2+ ⇒ new group. Every memberId must be an accepted friend of the
 *  caller — friendship gates DMs and group adds (BACKBONE §2). */
export async function createChat(creatorId: bigint, body: CreateChatRequest): Promise<CreateChatResult> {
  const requested = Array.isArray(body.memberIds) ? body.memberIds.map(parseUserId) : [];
  const memberIds = Array.from(new Set(requested)).filter((id) => id !== creatorId);
  if (memberIds.length === 0) throw validation('at least one other member is required');
  if (memberIds.length > ChatLimits.maxGroupMembers) {
    throw validation(`groups are limited to ${ChatLimits.maxGroupMembers} members`);
  }

  for (const id of memberIds) {
    if (!(await areFriends(creatorId, id))) throw forbidden('you can only add friends to a chat');
  }

  if (memberIds.length === 1) {
    const otherId = memberIds[0]!;
    const [a, b] = pair(creatorId, otherId);
    const dmKey = `${a}:${b}`;

    const existing = await db.select().from(chats).where(eq(chats.dmKey, dmKey)).limit(1);
    if (existing[0]) {
      const chat = existing[0];
      const membership = await db
        .select({ lastRead: chatMembers.lastReadMessageId })
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, creatorId)))
        .limit(1);
      return { chat: await buildSummary(chat, creatorId, membership[0]?.lastRead ?? null), created: false, newMemberIds: [] };
    }

    const chat = await db.transaction(async (tx) => {
      const inserted = await tx.insert(chats).values({ isGroup: false, dmKey, createdBy: creatorId }).returning();
      const created = inserted[0]!;
      await tx.insert(chatMembers).values([
        { chatId: created.id, userId: creatorId },
        { chatId: created.id, userId: otherId },
      ]);
      return created;
    });
    return { chat: await buildSummary(chat, creatorId, null), created: true, newMemberIds: [otherId] };
  }

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, ChatLimits.nameMax) : null;
  const chat = await db.transaction(async (tx) => {
    const inserted = await tx.insert(chats).values({ isGroup: true, name, createdBy: creatorId }).returning();
    const created = inserted[0]!;
    await tx.insert(chatMembers).values([
      { chatId: created.id, userId: creatorId, role: 'owner' },
      ...memberIds.map((id) => ({ chatId: created.id, userId: id })),
    ]);
    return created;
  });
  return { chat: await buildSummary(chat, creatorId, null), created: true, newMemberIds: memberIds };
}

/** GET /chats/:id/messages?before=&limit= — keyset pagination on id DESC.
 *  `viewerId` is needed to compute `reactions[].mine` per row. */
export async function getMessagesPage(
  chatId: bigint,
  before: bigint | null,
  limit: number,
  viewerId: bigint,
): Promise<MessagesResponse> {
  const conditions = [eq(messages.chatId, chatId), isNull(messages.deletedAt)];
  if (before !== null) conditions.push(lt(messages.id, before));

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit);

  const replyToIds = rows.map((r) => r.replyToMessageId).filter((id): id is bigint => id !== null);
  const [mediaMap, replyMap, reactionsMap] = await Promise.all([
    mediaInfoForMessages(rows.map((r) => r.id)),
    replyPreviewsForMessages(replyToIds),
    reactionsForMessages(rows.map((r) => r.id), viewerId),
  ]);

  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id.toString() : null;
  return {
    messages: rows.map((r) =>
      toMessage(
        r,
        mediaMap.get(r.id.toString()) ?? null,
        r.replyToMessageId ? (replyMap.get(r.replyToMessageId.toString()) ?? null) : null,
        reactionsMap.get(r.id.toString()) ?? [],
      ),
    ),
    nextCursor,
  };
}

/** Parsed/validated search filters — the route (chats.ts) does the raw
 *  querystring parsing + validation error throwing; this only shapes what it
 *  hands off. `null` fields mean "not filtering on this". */
export interface SearchFilters {
  q: string | null;
  from: bigint | null;
  since: Date | null;
  until: Date | null;
}

/** Escapes ILIKE's special characters so user input is matched as a literal
 *  substring (docs/MESSAGE_SEARCH.md §3.3) — an unescaped `%`/`_` would turn
 *  the pattern into a wildcard, which is both a correctness bug (surprise
 *  matches) and a cheap way to force a full-table scan. Backslash is
 *  Postgres's default ILIKE escape character, so escaping it first (so a
 *  literal backslash in the input doesn't itself become an escape) then
 *  escaping `%`/`_` is enough — no ESCAPE clause needed. */
function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** GET /chats/:id/messages/search — keyset pagination on id DESC, same shape
 *  as `getMessagesPage`. Deliberately does *not* add a blanket
 *  `body IS NOT NULL`: when `q` is set, `ILIKE` against a NULL body is
 *  already false (excluding captionless media naturally); when `q` is
 *  absent (a filter-only search — "everything Alice sent in March",
 *  docs/MESSAGE_SEARCH.md §1), captionless media messages must still be
 *  eligible, and the client renders them with a kind label (§4.4). System
 *  messages are always excluded — they're app-generated noise, not
 *  something a user searched for. */
export async function searchMessages(
  chatId: bigint,
  filters: SearchFilters,
  before: bigint | null,
  limit: number,
  viewerId: bigint,
): Promise<SearchMessagesResponse> {
  const baseConditions = [eq(messages.chatId, chatId), isNull(messages.deletedAt), ne(messages.kind, 'system')];
  if (filters.q) baseConditions.push(ilike(messages.body, `%${escapeLikePattern(filters.q)}%`));
  if (filters.from !== null) baseConditions.push(eq(messages.senderId, filters.from));
  if (filters.since) baseConditions.push(gte(messages.createdAt, filters.since));
  if (filters.until) {
    // `until` is a UTC day bound (inclusive) — the exclusive upper bound is
    // the start of the *next* day (docs/MESSAGE_SEARCH.md §3.3).
    const untilExclusive = new Date(filters.until.getTime() + 24 * 60 * 60 * 1000);
    baseConditions.push(lt(messages.createdAt, untilExclusive));
  }

  const conditions = before !== null ? [...baseConditions, lt(messages.id, before)] : baseConditions;

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const replyToIds = page.map((r) => r.replyToMessageId).filter((id): id is bigint => id !== null);
  const [mediaMap, replyMap, reactionsMap] = await Promise.all([
    mediaInfoForMessages(page.map((r) => r.id)),
    replyPreviewsForMessages(replyToIds),
    reactionsForMessages(page.map((r) => r.id), viewerId),
  ]);

  // Total count only on the first page (§3.3) — repaginating the same query
  // on every `before` page would be a wasted COUNT(*) the client never uses.
  let totalCount: number | null = null;
  if (before === null) {
    const countRows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(...baseConditions));
    totalCount = countRows[0]?.count ?? 0;
  }

  return {
    messages: page.map((r) =>
      toMessage(
        r,
        mediaMap.get(r.id.toString()) ?? null,
        r.replyToMessageId ? (replyMap.get(r.replyToMessageId.toString()) ?? null) : null,
        reactionsMap.get(r.id.toString()) ?? [],
      ),
    ),
    nextCursor: hasMore ? page[page.length - 1]!.id.toString() : null,
    totalCount,
  };
}

export async function markRead(chatId: bigint, userId: bigint, messageId: bigint): Promise<void> {
  await db
    .update(chatMembers)
    .set({ lastReadMessageId: messageId })
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
}

/** Persist a text message. Stage 2 only supports `kind: 'text'` — media kinds
 *  arrive in Stage 3 via the upload-complete flow, not this path. `replyToId`
 *  is post-MVP; a brand-new message never has reactions yet. */
export async function sendTextMessage(
  chatId: bigint,
  senderId: bigint,
  body: string,
  replyToId?: bigint,
): Promise<MessageDto> {
  const trimmed = body.trim();
  if (!trimmed) throw validation('message body cannot be empty');
  if (trimmed.length > ChatLimits.messageBodyMax) {
    throw validation(`message too long (max ${ChatLimits.messageBodyMax} characters)`);
  }
  if (replyToId !== undefined) await assertReplyTarget(chatId, replyToId);

  const inserted = await db
    .insert(messages)
    .values({ chatId, senderId, kind: 'text', body: trimmed, replyToMessageId: replyToId ?? null })
    .returning();
  const row = inserted[0]!;
  const replyTo = await replyPreviewFor(row.replyToMessageId);
  return toMessage(row, null, replyTo, []);
}

// ─── message deletion (Stage 6 / BACKBONE §2 item 11, docs/archive/MESSAGE_DELETE.md) ──

function parseMessageId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw validation('invalid message id');
  }
}

/** Parses + dedupes a message-id batch and enforces the size ceiling. Shared
 *  by soft-delete and restore — both are all-or-nothing batch ops. */
function parseMessageIdBatch(rawIds: string[]): bigint[] {
  if (!Array.isArray(rawIds) || rawIds.length === 0) throw validation('messageIds must be a non-empty array');
  if (rawIds.length > ChatLimits.deleteBatchMax) {
    throw validation(`batches are limited to ${ChatLimits.deleteBatchMax} messages`);
  }
  return Array.from(new Set(rawIds.map(parseMessageId)));
}

/** Loads message rows by id and enforces "every id belongs to this chat and
 *  was sent by this caller" as a single all-or-nothing check — a missing id,
 *  a wrong-chat id, or someone else's message throws 403 for the *whole*
 *  batch and nothing is written (docs/archive/MESSAGE_DELETE.md §3: "Partial success
 *  is a worse UX than a clean refusal and leaks which ids exist"). */
async function loadOwnMessagesOrThrow(chatId: bigint, senderId: bigint, ids: bigint[]) {
  const rows = await db.select().from(messages).where(inArray(messages.id, ids));
  if (rows.length !== ids.length || rows.some((r) => r.chatId !== chatId || r.senderId !== senderId)) {
    throw forbidden('all messages must be your own, in this chat');
  }
  return rows;
}

/** Soft-deletes the caller's own messages in this chat (CLAUDE.md #8: sets
 *  `deleted_at` only — never `DELETE`, never touches media/R2/tags, those
 *  belong to the iceboxed hard wipe). Idempotent: an already-deleted id is a
 *  no-op; the returned list is only the ids that actually transitioned, so
 *  the caller's WS broadcast never announces a phantom change. */
export async function softDeleteMessages(viewerId: bigint, chatId: bigint, rawIds: string[]): Promise<string[]> {
  await assertMember(viewerId, chatId);
  const ids = parseMessageIdBatch(rawIds);
  const rows = await loadOwnMessagesOrThrow(chatId, viewerId, ids);

  const toDelete = rows.filter((r) => r.deletedAt === null).map((r) => r.id);
  if (toDelete.length === 0) return [];
  await db.update(messages).set({ deletedAt: new Date() }).where(inArray(messages.id, toDelete));
  return toDelete.map((id) => id.toString());
}

/** Restores messages the caller previously soft-deleted (the undo toast).
 *  Same all-or-nothing ownership rule as `softDeleteMessages`. Deliberately
 *  has no server-side time limit — the ~10s undo window is purely the
 *  client toast's lifetime; this is the seed a future trash page could grow
 *  from, at no cost now. Returns full DTOs (with fresh media URLs), not just
 *  ids: other members already dropped their local copy on `message.deleted`
 *  and can't reconstruct it from an id alone. */
export async function restoreMessages(viewerId: bigint, chatId: bigint, rawIds: string[]): Promise<MessageDto[]> {
  await assertMember(viewerId, chatId);
  const ids = parseMessageIdBatch(rawIds);
  const rows = await loadOwnMessagesOrThrow(chatId, viewerId, ids);

  const toRestore = rows.filter((r) => r.deletedAt !== null).map((r) => r.id);
  if (toRestore.length === 0) return [];
  await db.update(messages).set({ deletedAt: null }).where(inArray(messages.id, toRestore));

  const restoredRows = await db.select().from(messages).where(inArray(messages.id, toRestore));
  const replyToIds = restoredRows.map((r) => r.replyToMessageId).filter((id): id is bigint => id !== null);
  const [mediaMap, replyMap, reactionsMap] = await Promise.all([
    mediaInfoForMessages(toRestore),
    replyPreviewsForMessages(replyToIds),
    reactionsForMessages(toRestore, viewerId),
  ]);
  return restoredRows.map((r) =>
    toMessage(
      r,
      mediaMap.get(r.id.toString()) ?? null,
      r.replyToMessageId ? (replyMap.get(r.replyToMessageId.toString()) ?? null) : null,
      reactionsMap.get(r.id.toString()) ?? [],
    ),
  );
}

// ─── message edit (post-MVP, docs/MESSAGE_EDIT.md) ──────────────────────

/** Kinds an edit may touch — text messages and media captions. Voice and
 *  system messages are excluded (docs/MESSAGE_EDIT.md §1 "explicitly out of
 *  scope"). */
const EDITABLE_KINDS = new Set(['text', 'image', 'video']);

export interface EditMessageResult {
  message: MessageDto;
  /** False on a no-op edit (trimmed body equals the current body) — the
   *  route skips the WS broadcast in that case, same "no phantom frame" rule
   *  as `softDeleteMessages`/`restoreMessages`. */
  changed: boolean;
}

async function messageDtoFor(row: typeof messages.$inferSelect, viewerId: bigint): Promise<MessageDto> {
  const [replyTo, mediaMap, reactionsMap] = await Promise.all([
    replyPreviewFor(row.replyToMessageId),
    mediaInfoForMessages([row.id]),
    reactionsForMessages([row.id], viewerId),
  ]);
  return toMessage(row, mediaMap.get(row.id.toString()) ?? null, replyTo, reactionsMap.get(row.id.toString()) ?? []);
}

/** Edits the caller's own message body in place (own messages only, body
 *  only — text messages and media captions; the edit never touches `media`).
 *  No time limit (owner decision, docs/MESSAGE_EDIT.md §1 — fits the closed-
 *  friend-circle trust model). Same all-or-nothing 403 posture as
 *  `softDeleteMessages`: membership + ownership are enforced here, not the
 *  route. Ordering deliberately checks "does this message exist, in this
 *  chat" before ownership so a wrong-chat id 404s rather than leaking that a
 *  message with that id exists somewhere else; soft-deleted messages also
 *  404 (not editable) rather than 403, since "not found" is exactly how every
 *  other read path already treats a deleted row (`getMessagesPage` etc.). */
export async function editMessage(
  viewerId: bigint,
  chatId: bigint,
  messageId: bigint,
  rawBody: string,
): Promise<EditMessageResult> {
  await assertMember(viewerId, chatId);

  const rows = await db.select().from(messages).where(eq(messages.id, messageId));
  const row = rows[0];
  if (!row || row.chatId !== chatId) throw notFound('message not found');
  if (row.senderId !== viewerId) throw forbidden('you can only edit your own messages');
  if (row.deletedAt !== null) throw notFound('message not found');
  if (!EDITABLE_KINDS.has(row.kind)) throw validation('this message cannot be edited');

  const trimmed = typeof rawBody === 'string' ? rawBody.trim() : '';
  if (!trimmed) throw validation('message body cannot be empty');
  if (trimmed.length > ChatLimits.messageBodyMax) {
    throw validation(`message too long (max ${ChatLimits.messageBodyMax} characters)`);
  }

  // No-op guard: an edit that doesn't actually change the body returns the
  // message unchanged and tells the route not to broadcast anything.
  if (row.body === trimmed) {
    return { message: await messageDtoFor(row, viewerId), changed: false };
  }

  const updated = await db
    .update(messages)
    .set({ body: trimmed, editedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  const updatedRow = updated[0]!;
  return { message: await messageDtoFor(updatedRow, viewerId), changed: true };
}
