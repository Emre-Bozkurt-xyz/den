/**
 * Embed business logic (docs/EMBEDS.md §4.3). Mirrors media/service.ts's
 * split and lifecycle exactly:
 *
 *   1. createEmbedMessage — mints the `messages` row (kind='embed') + an
 *      `embeds` row (status='processing') in one transaction. The caller
 *      (ws.ts) broadcasts `message.new` with this placeholder immediately,
 *      same as the media upload-complete placeholder.
 *   2. finalizeEmbed — runs the provider resolver (embeds/registry.ts) and
 *      flips the row to 'ready'/'failed'; the caller broadcasts
 *      `embed.ready` afterward.
 *
 * Unlike media, there is no client-upload step in between — an embed's
 * "bytes" are a URL the server itself fetches, so mint and resolve are two
 * steps of the same request/response cycle, not two separate REST calls.
 */
import { eq, inArray } from 'drizzle-orm';
import { ChatLimits, type EmbedInfo, type EmbedProvider, type Message as MessageDto } from '@den/shared';
import { db } from '../db/index.js';
import { embeds, messages } from '../db/schema.js';
import { toEmbedInfo, toMessage, type EmbedRow, type MessageRow } from '../mappers.js';
import { notFound, validation } from '../errors.js';
import { presignGet } from '../media/r2.js';
import { resolverFor } from './registry.js';
import { assertReplyTarget, replyPreviewFor } from '../chat/replies.js';

interface EmbedJoinRow extends EmbedRow {
  messageId: bigint;
  chatId: bigint;
  thumbKey: string | null;
}

const embedOnlyShape = {
  id: embeds.id,
  messageId: embeds.messageId,
  provider: embeds.provider,
  status: embeds.status,
  title: embeds.title,
  subtitle: embeds.subtitle,
  description: embeds.description,
  thumbKey: embeds.thumbKey,
  canonicalUrl: embeds.canonicalUrl,
  providerRef: embeds.providerRef,
  contentKind: embeds.contentKind,
  actionType: embeds.actionType,
} as const;

async function embedRowById(embedId: bigint): Promise<EmbedJoinRow | null> {
  const rows = await db
    .select({ ...embedOnlyShape, chatId: messages.chatId })
    .from(embeds)
    .innerJoin(messages, eq(messages.id, embeds.messageId))
    .where(eq(embeds.id, embedId))
    .limit(1);
  return rows[0] ?? null;
}

async function messageById(id: bigint): Promise<MessageRow> {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  return row;
}

/** Batch-fetch + presign embed cards for a page of messages — the embed
 *  analogue of media/service.ts's `mediaInfoForMessages`, same reasoning
 *  (presigning is a local HMAC computation, cheap per-row for a page). */
export async function embedInfoForMessages(messageIds: bigint[]): Promise<Map<string, EmbedInfo>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db.select(embedOnlyShape).from(embeds).where(inArray(embeds.messageId, messageIds));

  const out = new Map<string, EmbedInfo>();
  await Promise.all(
    rows.map(async (row) => {
      const thumbUrl = row.thumbKey ? await presignGet(row.thumbKey) : null;
      out.set(row.messageId.toString(), toEmbedInfo(row, thumbUrl));
    }),
  );
  return out;
}

export interface CreateEmbedMessageResult {
  message: MessageDto;
  chatId: bigint;
  embedId: bigint;
}

/** Message-mint path (docs/EMBEDS.md §4.3) — the embed analogue of
 *  media/service.ts's createUpload+completeUpload combined into one step,
 *  since there's no client upload in between. `caption` is the free text
 *  left over after the detected URL is stripped out (shared/src/embeds.ts's
 *  `stripEmbedUrl`) — null, not '', when nothing is left. */
export async function createEmbedMessage(
  chatId: bigint,
  senderId: bigint,
  provider: EmbedProvider,
  url: string,
  providerRef: string,
  caption: string | null,
  replyToId?: bigint,
): Promise<CreateEmbedMessageResult> {
  if (caption && caption.length > ChatLimits.messageBodyMax) {
    throw validation(`message too long (max ${ChatLimits.messageBodyMax} characters)`);
  }
  if (replyToId !== undefined) await assertReplyTarget(chatId, replyToId);

  const embedId = await db.transaction(async (tx) => {
    const msgInserted = await tx
      .insert(messages)
      .values({ chatId, senderId, kind: 'embed', body: caption, replyToMessageId: replyToId ?? null })
      .returning();
    const messageRow = msgInserted[0]!;
    const embedInserted = await tx
      .insert(embeds)
      .values({ messageId: messageRow.id, provider, status: 'processing', canonicalUrl: url, providerRef })
      .returning({ id: embeds.id });
    return embedInserted[0]!.id;
  });

  const row = await embedRowById(embedId);
  if (!row) throw notFound('embed not found');
  const messageRow = await messageById(row.messageId);
  const replyTo = await replyPreviewFor(messageRow.replyToMessageId);

  return {
    message: toMessage(messageRow, null, replyTo, [], toEmbedInfo(row, null)),
    chatId: row.chatId,
    embedId,
  };
}

/** Runs the provider resolver and flips the row to ready/failed — the embed
 *  analogue of media/service.ts's `finalizeProcessing`. Returns the updated
 *  message DTO for the caller (ws.ts) to broadcast as `embed.ready`. Errors
 *  from the resolver (network, parse, SSRF-guard refusal) are swallowed into
 *  a 'failed' row by design (CLAUDE.md: a bad/hostile URL must not crash the
 *  request that triggered it), but logged so a real outage is diagnosable. */
export async function finalizeEmbed(embedId: bigint): Promise<MessageDto> {
  const row = await embedRowById(embedId);
  if (!row) throw notFound('embed not found');

  const resolve = resolverFor(row.provider as EmbedProvider);
  if (!resolve) {
    console.error(`no resolver registered for embed provider "${row.provider}" (embed ${embedId})`);
    await db.update(embeds).set({ status: 'failed' }).where(eq(embeds.id, embedId));
  } else {
    try {
      const result = await resolve({
        chatId: row.chatId,
        embedId: row.id,
        url: row.canonicalUrl ?? '',
        providerRef: row.providerRef ?? '',
      });
      await db
        .update(embeds)
        .set({
          title: result.title,
          subtitle: result.subtitle,
          description: result.description,
          thumbKey: result.thumbKey,
          canonicalUrl: result.canonicalUrl ?? row.canonicalUrl,
          contentKind: result.contentKind,
          actionType: result.actionType,
          data: result.data ?? null,
          status: 'ready',
        })
        .where(eq(embeds.id, embedId));
    } catch (err) {
      console.error(`embed resolution failed for embed ${embedId} (provider ${row.provider}):`, err instanceof Error ? err.message : err);
      await db.update(embeds).set({ status: 'failed' }).where(eq(embeds.id, embedId));
    }
  }

  const updated = await embedRowById(embedId);
  if (!updated) throw notFound('embed not found');
  const messageRow = await messageById(updated.messageId);
  const [replyTo, thumbUrl] = await Promise.all([
    replyPreviewFor(messageRow.replyToMessageId),
    updated.thumbKey ? presignGet(updated.thumbKey) : Promise.resolve(null),
  ]);
  return toMessage(messageRow, null, replyTo, [], toEmbedInfo(updated, thumbUrl));
}
