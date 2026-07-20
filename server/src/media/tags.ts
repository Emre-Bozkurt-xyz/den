/**
 * Tag registry logic (Stage 5, BACKBONE §5). Shared-wiki permissions: any
 * chat member may attach/detach any tag — `taggedBy` is attribution, not
 * ownership, so there's no per-tag authorization beyond chat membership
 * (already asserted by the calling route).
 */
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { normalizeTagName, type Tag } from '@den/shared';
import { db } from '../db/index.js';
import { mediaTags, tags } from '../db/schema.js';
import { validation } from '../errors.js';

function toTag(row: { id: bigint; name: string; usageCount: number }): Tag {
  return { id: row.id.toString(), name: row.name, usageCount: row.usageCount };
}

/** GET /chats/:id/tags?prefix= — ranked by usage, then name (§5). */
export async function autocompleteTags(chatId: bigint, prefix: string): Promise<Tag[]> {
  const rows = await db
    .select({ id: tags.id, name: tags.name, usageCount: tags.usageCount })
    .from(tags)
    .where(and(eq(tags.chatId, chatId), like(tags.name, `${prefix}%`)))
    .orderBy(desc(tags.usageCount), tags.name)
    .limit(10);
  return rows.map(toTag);
}

/** POST /media/:id/tags. Creates the tag in the chat's registry if it's new,
 *  attaches it to the media, and bumps `usage_count` — but only once per
 *  (media, tag) pair (re-tagging something already tagged is a no-op, not a
 *  double count). */
export async function addTag(chatId: bigint, mediaId: bigint, userId: bigint, rawName: string): Promise<Tag> {
  const name = normalizeTagName(rawName);
  if (!name) throw validation('invalid tag name');

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: tags.id, name: tags.name, usageCount: tags.usageCount })
      .from(tags)
      .where(and(eq(tags.chatId, chatId), eq(tags.name, name)))
      .limit(1);

    let tag = existing[0];
    if (!tag) {
      const inserted = await tx
        .insert(tags)
        .values({ chatId, name, createdBy: userId })
        .onConflictDoNothing()
        .returning({ id: tags.id, name: tags.name, usageCount: tags.usageCount });
      // Race with another member creating the same tag concurrently: re-select.
      tag =
        inserted[0] ??
        (
          await tx
            .select({ id: tags.id, name: tags.name, usageCount: tags.usageCount })
            .from(tags)
            .where(and(eq(tags.chatId, chatId), eq(tags.name, name)))
            .limit(1)
        )[0];
    }
    if (!tag) throw new Error('failed to create or find tag');

    const attached = await tx
      .insert(mediaTags)
      .values({ mediaId, tagId: tag.id, taggedBy: userId })
      .onConflictDoNothing()
      .returning({ mediaId: mediaTags.mediaId });

    if (attached.length === 0) return toTag(tag); // already tagged — no-op

    const updated = await tx
      .update(tags)
      .set({ usageCount: sql`${tags.usageCount} + 1` })
      .where(eq(tags.id, tag.id))
      .returning({ id: tags.id, name: tags.name, usageCount: tags.usageCount });
    return toTag(updated[0]!);
  });
}

/** DELETE /media/:id/tags/:tagId. No-op (not an error) if the media wasn't
 *  tagged with it — matches the "any member may remove any tag" shared-wiki
 *  model where there's nothing to protect against a redundant call. */
export async function removeTag(mediaId: bigint, tagId: bigint): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(mediaTags)
      .where(and(eq(mediaTags.mediaId, mediaId), eq(mediaTags.tagId, tagId)))
      .returning({ mediaId: mediaTags.mediaId });
    if (deleted.length === 0) return;
    await tx
      .update(tags)
      .set({ usageCount: sql`GREATEST(${tags.usageCount} - 1, 0)` })
      .where(eq(tags.id, tagId));
  });
}

/** Resolve tag names → ids scoped to a chat. Used to build the gallery query
 *  (media/gallery.ts). Names that don't exist in the chat's registry are
 *  simply absent from the result — the caller decides what that means (an
 *  unresolvable *positive* tag means "empty result set", per §5 booru
 *  behavior; an unresolvable negative tag just excludes nothing). */
export async function resolveTagIds(chatId: bigint, names: string[]): Promise<bigint[]> {
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.chatId, chatId), inArray(tags.name, names)));
  return rows.map((r) => r.id);
}

/** Batch tag lookup for a page of gallery items (media/gallery.ts). */
export async function tagsForMediaIds(mediaIds: bigint[]): Promise<Map<string, Tag[]>> {
  if (mediaIds.length === 0) return new Map();
  const rows = await db
    .select({ mediaId: mediaTags.mediaId, id: tags.id, name: tags.name, usageCount: tags.usageCount })
    .from(mediaTags)
    .innerJoin(tags, eq(tags.id, mediaTags.tagId))
    .where(inArray(mediaTags.mediaId, mediaIds))
    .orderBy(desc(tags.usageCount));

  const map = new Map<string, Tag[]>();
  for (const row of rows) {
    const key = row.mediaId.toString();
    const list = map.get(key) ?? [];
    list.push(toTag(row));
    map.set(key, list);
  }
  return map;
}
