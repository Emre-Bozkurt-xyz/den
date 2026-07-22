/**
 * Gallery queries (Stage 4/5, BACKBONE §5/§6/§9). Type-filtered,
 * tag-filtered, keyset-paginated per-chat grid + the top-level
 * chats-as-albums listing. Callers assert chat membership before calling
 * into this module (CLAUDE.md hard invariant 1); it trusts its inputs.
 *
 * Tag filtering (§5 reference impl) is the one place this module drops to
 * raw SQL fragments inside the drizzle query builder — expressing "media has
 * ALL of these tags" as ORM joins is awkward; NOT EXISTS/unnest is the
 * documented reference query and is kept visible here per CLAUDE.md
 * ("raw SQL allowed only for the gallery tag query... keep the SQL visible").
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { parseTagQuery, type GalleryAlbum, type GalleryItem, type GalleryKindFilter, type GalleryResponse } from '@den/shared';
import { db } from '../db/index.js';
import { media, messages } from '../db/schema.js';
import { toMediaInfo } from '../mappers.js';
import { listChatsForUser } from '../chat/service.js';
import { presignGet } from './r2.js';
import { resolveTagIds, tagsForMediaIds } from './tags.js';

const gallerySelectShape = {
  id: media.id,
  messageId: media.messageId,
  kind: media.kind,
  r2Key: media.r2Key,
  mime: media.mime,
  sizeBytes: media.sizeBytes,
  width: media.width,
  height: media.height,
  durationMs: media.durationMs,
  thumbKey: media.thumbKey,
  status: media.status,
  messageChatId: messages.chatId,
  messageSenderId: messages.senderId,
  messageCreatedAt: messages.createdAt,
} as const;

/** GET /chats/:id/gallery — media in the chat matching an optional type
 *  filter and booru-style tag query, newest first, keyset-paginated on media
 *  id (BACKBONE §5/§6). Only status='ready' items show — a
 *  processing/failed upload isn't a gallery item yet (still a chat bubble).
 *  An unresolvable positive tag returns an empty page immediately, without
 *  running the media query at all (§5 booru behavior). */
export async function getGalleryPage(
  chatId: bigint,
  kind: GalleryKindFilter | null,
  rawQuery: string | null,
  before: bigint | null,
  limit: number,
): Promise<GalleryResponse> {
  const conditions = [eq(messages.chatId, chatId), isNull(messages.deletedAt), eq(media.status, 'ready')];
  // 'visual' = image OR video — the Media segment's grid (BACKBONE §15
  // 2026-07-22); any other value is a single MediaKind (Voice segment uses
  // 'voice').
  if (kind === 'visual') conditions.push(inArray(media.kind, ['image', 'video']));
  else if (kind) conditions.push(eq(media.kind, kind));
  if (before !== null) conditions.push(lt(media.id, before));

  if (rawQuery?.trim()) {
    const { positive, negative } = parseTagQuery(rawQuery);
    const [positiveIds, negativeIds] = await Promise.all([resolveTagIds(chatId, positive), resolveTagIds(chatId, negative)]);

    if (positive.length > 0 && positiveIds.length < positive.length) {
      return { items: [], nextCursor: null }; // an unknown positive tag can never match anything
    }
    // Each required tag gets its own EXISTS clause, ANDed together —
    // equivalent to §5's unnest-based reference query ("media must have ALL
    // of these") but expressed as scalar-bound predicates instead of an
    // array parameter: postgres.js/drizzle's `sql` template doesn't cleanly
    // bind a JS array to a `::bigint[]` cast (errors "cannot cast type
    // record to bigint[]"), so this sidesteps that rather than fighting it.
    for (const id of positiveIds) {
      conditions.push(sql`EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = ${media.id} AND mt.tag_id = ${id})`);
    }
    if (negativeIds.length > 0) {
      const idList = sql.join(
        negativeIds.map((id) => sql`${id}`),
        sql`, `,
      );
      conditions.push(sql`NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = ${media.id} AND mt.tag_id IN (${idList}))`);
    }
  }

  const rows = await db
    .select(gallerySelectShape)
    .from(media)
    .innerJoin(messages, eq(messages.id, media.messageId))
    .where(and(...conditions))
    .orderBy(desc(media.id))
    .limit(limit);

  const tagMap = await tagsForMediaIds(rows.map((r) => r.id));

  const items: GalleryItem[] = await Promise.all(
    rows.map(async (row) => {
      const urls = { url: await presignGet(row.r2Key), thumbUrl: row.thumbKey ? await presignGet(row.thumbKey) : null };
      return {
        media: toMediaInfo(row, urls),
        messageId: row.messageId.toString(),
        chatId: row.messageChatId.toString(),
        senderId: row.messageSenderId.toString(),
        createdAt: row.messageCreatedAt.toISOString(),
        tags: tagMap.get(row.id.toString()) ?? [],
      };
    }),
  );

  const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id.toString() : null;
  return { items, nextCursor };
}

interface ChatMediaSummary {
  coverThumbKey: string | null;
  count: number;
}

async function mediaSummaryFor(chatId: bigint): Promise<ChatMediaSummary> {
  const [countRows, latestWithThumbRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(media)
      .innerJoin(messages, eq(messages.id, media.messageId))
      .where(and(eq(messages.chatId, chatId), isNull(messages.deletedAt), eq(media.status, 'ready'))),
    // Cover = latest ready media *that has a thumbnail* (BACKBONE §15
    // 2026-07-22), not just the latest ready item overall — voice never has
    // a thumb_key, so picking the bare-latest item previously left the album
    // tile blank whenever the newest upload in a chat was a voice message.
    db
      .select({ thumbKey: media.thumbKey })
      .from(media)
      .innerJoin(messages, eq(messages.id, media.messageId))
      .where(
        and(
          eq(messages.chatId, chatId),
          isNull(messages.deletedAt),
          eq(media.status, 'ready'),
          isNotNull(media.thumbKey),
        ),
      )
      .orderBy(desc(media.id))
      .limit(1),
  ]);

  return {
    count: countRows[0]?.count ?? 0,
    coverThumbKey: latestWithThumbRows[0]?.thumbKey ?? null,
  };
}

/** GET /gallery/albums — every chat with ≥1 ready media item, as an album
 *  tile. Reuses listChatsForUser for name/members/isGroup rather than
 *  re-deriving them, then attaches gallery-specific cover/count per chat. */
export async function getAlbumsForUser(userId: bigint): Promise<GalleryAlbum[]> {
  const chats = await listChatsForUser(userId);
  if (chats.length === 0) return [];

  const summaries = await Promise.all(chats.map((c) => mediaSummaryFor(BigInt(c.id))));

  const albums: GalleryAlbum[] = [];
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i]!;
    const summary = summaries[i]!;
    if (summary.count === 0) continue;
    albums.push({
      chatId: chat.id,
      name: chat.name,
      isGroup: chat.isGroup,
      members: chat.members,
      coverThumbUrl: summary.coverThumbKey ? await presignGet(summary.coverThumbKey) : null,
      mediaCount: summary.count,
    });
  }
  return albums;
}
