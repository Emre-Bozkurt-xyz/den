/**
 * Reply previews (post-MVP, BACKBONE §5/§6). A reply carries a lightweight
 * snapshot of the referenced message inline on `Message.replyTo` so the
 * client never needs a second fetch to render a reply strip — even if the
 * referenced message is off-page or was since soft-deleted.
 */
import { eq, inArray } from 'drizzle-orm';
import type { MessageKind, ReplyPreview } from '@den/shared';
import { db } from '../db/index.js';
import { messages } from '../db/schema.js';
import { validation } from '../errors.js';

const MEDIA_LABEL: Record<MessageKind, string> = {
  text: '',
  system: '',
  image: '📷 Photo',
  video: '🎥 Video',
  voice: '🎤 Voice message',
};

/** Batch-resolve reply previews for a page of messages, keyed by the
 *  REFERENCED message id (chat/service.ts, media/service.ts). */
export async function replyPreviewsForMessages(replyToIds: bigint[]): Promise<Map<string, ReplyPreview>> {
  if (replyToIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: messages.id,
      senderId: messages.senderId,
      kind: messages.kind,
      body: messages.body,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(inArray(messages.id, replyToIds));

  const map = new Map<string, ReplyPreview>();
  for (const row of rows) {
    const deleted = row.deletedAt !== null;
    const kind = row.kind as MessageKind;
    const preview = deleted ? '' : (row.body?.slice(0, 120) ?? '') || MEDIA_LABEL[kind];
    map.set(row.id.toString(), {
      id: row.id.toString(),
      senderId: row.senderId.toString(),
      kind,
      preview,
      deleted,
    });
  }
  return map;
}

/** Single-row convenience wrapper — used where resolving one reply preview
 *  is cheap enough not to warrant batching (e.g. lastMessageOf). */
export async function replyPreviewFor(replyToId: bigint | null): Promise<ReplyPreview | null> {
  if (replyToId === null) return null;
  const map = await replyPreviewsForMessages([replyToId]);
  return map.get(replyToId.toString()) ?? null;
}

/** Verifies `replyToId` references a non-deleted message in the SAME chat —
 *  a reply can't point across chats or at a message the author can no longer
 *  see (CLAUDE.md hard invariant 1: authorization = chat membership). Shared
 *  by chat/service.ts (text sends) and media/service.ts (upload-complete). */
export async function assertReplyTarget(chatId: bigint, replyToId: bigint): Promise<void> {
  const rows = await db
    .select({ chatId: messages.chatId, deletedAt: messages.deletedAt })
    .from(messages)
    .where(eq(messages.id, replyToId))
    .limit(1);
  const row = rows[0];
  if (!row || row.chatId !== chatId) throw validation('replyToId must reference a message in this chat');
  if (row.deletedAt !== null) throw validation('cannot reply to a deleted message');
}
