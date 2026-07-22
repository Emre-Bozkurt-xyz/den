/**
 * Message reactions (post-MVP, BACKBONE §5/§6). No per-reaction ownership
 * beyond "you can only add/remove your own row" — the PK is
 * (message_id, user_id, emoji), so a user can only ever have one reaction row
 * per emoji per message. Follows the style of media/tags.ts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ReactionLimits, type ReactionSummary } from '@den/shared';
import { db } from '../db/index.js';
import { messageReactions, messages } from '../db/schema.js';
import { notFound, validation } from '../errors.js';

/** Batch-aggregate reactions for a page of messages (chat/service.ts,
 *  media/service.ts). One grouped query, keyed by messageId string. */
export async function reactionsForMessages(
  messageIds: bigint[],
  viewerId: bigint,
): Promise<Map<string, ReactionSummary[]>> {
  if (messageIds.length === 0) return new Map();

  const rows = await db
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      count: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${messageReactions.userId} = ${viewerId})`,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .groupBy(messageReactions.messageId, messageReactions.emoji)
    .orderBy(sql`count(*) DESC`, messageReactions.emoji);

  const map = new Map<string, ReactionSummary[]>();
  for (const row of rows) {
    const key = row.messageId.toString();
    const list = map.get(key) ?? [];
    list.push({ emoji: row.emoji, count: row.count, mine: row.mine });
    map.set(key, list);
  }
  return map;
}

function normalizeEmoji(raw: unknown): string {
  if (typeof raw !== 'string') throw validation('emoji is required');
  const trimmed = raw.trim();
  if (!trimmed) throw validation('emoji is required');
  if (trimmed.length > ReactionLimits.emojiMaxLength) {
    throw validation(`emoji is limited to ${ReactionLimits.emojiMaxLength} characters`);
  }
  if (/[\r\n]/.test(trimmed)) throw validation('emoji cannot contain newlines');
  return trimmed;
}

/** Verifies the message exists in this chat and isn't deleted before letting
 *  a reaction attach — a reaction on a soft-deleted or cross-chat message
 *  would be unreachable/unauthorized noise (CLAUDE.md hard invariant 1/8). */
async function assertReactableMessage(chatId: bigint, messageId: bigint): Promise<void> {
  const rows = await db
    .select({ chatId: messages.chatId, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  if (row.chatId !== chatId) throw notFound('message not found');
  if (row.deletedAt !== null) throw validation('cannot react to a deleted message');
}

/** POST /chats/:id/messages/:messageId/reactions. Idempotent: reacting twice
 *  with the same emoji is a no-op (onConflictDoNothing on the PK). */
export async function addReaction(chatId: bigint, messageId: bigint, userId: bigint, emojiRaw: string): Promise<void> {
  const emoji = normalizeEmoji(emojiRaw);
  await assertReactableMessage(chatId, messageId);
  await db.insert(messageReactions).values({ messageId, userId, emoji }).onConflictDoNothing();
}

/** DELETE /chats/:id/messages/:messageId/reactions/:emoji. No-op if the
 *  caller never had that reaction — nothing to protect against a redundant
 *  call (matches removeTag's shared-wiki-adjacent idempotency). */
export async function removeReaction(chatId: bigint, messageId: bigint, userId: bigint, emojiRaw: string): Promise<void> {
  const emoji = normalizeEmoji(emojiRaw);
  await assertReactableMessage(chatId, messageId);
  await db
    .delete(messageReactions)
    .where(and(eq(messageReactions.messageId, messageId), eq(messageReactions.userId, userId), eq(messageReactions.emoji, emoji)));
}
