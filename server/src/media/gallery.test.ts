/**
 * `getGalleryPage`'s `totalCount` (docs/GALLERY_FILMSTRIP.md §4/§6) — the
 * number the viewer's filmstrip sizes its ghost slots off.
 *
 * The property that matters is that it is **filter-aware**: it must count the
 * current kind + tag query's result set, not the whole chat, or the rail
 * claims slots that can never fill. It also has to be first-page-only, so the
 * client reads it off page 0 and later pages stay cheap.
 *
 * Runs against the real dev Postgres like the other service tests. Media rows
 * are inserted directly as `status: 'ready'` — no upload/processing needed,
 * since presigning is a local HMAC and never touches storage.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, media, mediaTags, messages, tags, users } from '../db/schema.js';
import { addTag } from './tags.js';
import { getGalleryPage } from './gallery.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let userId: bigint;
let otherId: bigint;
let chatId: bigint;
/** Media ids in insertion order (so id ASC == creation order). */
const mediaIds: bigint[] = [];

async function insertUser(suffix: string): Promise<bigint> {
  const username = `gallery-test-${suffix}-${RUN_ID}`;
  const rows = await db.insert(users).values({ username, displayName: username }).returning({ id: users.id });
  return rows[0]!.id;
}

async function insertReadyImage(): Promise<bigint> {
  const msgRows = await db
    .insert(messages)
    .values({ chatId, senderId: userId, kind: 'image', body: null })
    .returning({ id: messages.id });
  const messageId = msgRows[0]!.id;
  const mediaRows = await db
    .insert(media)
    .values({
      messageId,
      uploaderId: userId,
      kind: 'image',
      r2Key: `media/${chatId}/x/orig.webp`,
      mime: 'image/webp',
      sizeBytes: BigInt(1024),
      status: 'ready',
      thumbKey: `media/${chatId}/x/thumb.webp`,
    })
    .returning({ id: media.id });
  return mediaRows[0]!.id;
}

before(async () => {
  userId = await insertUser('a');
  otherId = await insertUser('b');
  const [lo, hi] = userId < otherId ? [userId, otherId] : [otherId, userId];
  const chatRows = await db
    .insert(chats)
    .values({ isGroup: false, dmKey: `${lo}:${hi}`, createdBy: userId })
    .returning({ id: chats.id });
  chatId = chatRows[0]!.id;
  await db.insert(chatMembers).values([
    { chatId, userId },
    { chatId, userId: otherId },
  ]);

  for (let i = 0; i < 5; i++) mediaIds.push(await insertReadyImage());
  // Exactly two of the five carry `sunset`.
  await addTag(chatId, mediaIds[0]!, userId, 'sunset');
  await addTag(chatId, mediaIds[1]!, userId, 'sunset');
});

after(async () => {
  if (mediaIds.length > 0) await db.delete(mediaTags).where(inArray(mediaTags.mediaId, mediaIds));
  const msgRows = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
  const msgIds = msgRows.map((r) => r.id);
  if (msgIds.length > 0) await db.delete(media).where(inArray(media.messageId, msgIds));
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(tags).where(eq(tags.chatId, chatId));
  await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(inArray(users.id, [userId, otherId]));
  await closeDb();
});

describe('getGalleryPage totalCount (docs/GALLERY_FILMSTRIP.md §4)', () => {
  test('counts the whole filtered set, not just the returned page', async () => {
    const page = await getGalleryPage(chatId, 'visual', null, null, 2);
    assert.equal(page.items.length, 2, 'page respects the limit');
    assert.equal(page.totalCount, 5, 'but the count covers every match');
    assert.ok(page.nextCursor, 'a full page hands back a cursor');
  });

  test('is first-page-only — null once a cursor is supplied', async () => {
    const first = await getGalleryPage(chatId, 'visual', null, null, 2);
    const second = await getGalleryPage(chatId, 'visual', null, BigInt(first.nextCursor!), 2);
    assert.equal(second.totalCount, null, 'later pages stay cheap; the client keeps page 0’s count');
    assert.ok(second.items.length > 0, 'the second page still returns items');
  });

  test('respects a positive tag filter', async () => {
    const page = await getGalleryPage(chatId, 'visual', 'sunset', null, 60);
    assert.equal(page.items.length, 2);
    assert.equal(page.totalCount, 2, 'counting the whole chat here would over-size the filmstrip');
  });

  test('respects a negated tag filter', async () => {
    const page = await getGalleryPage(chatId, 'visual', '-sunset', null, 60);
    assert.equal(page.items.length, 3);
    assert.equal(page.totalCount, 3);
  });

  test('an unresolvable positive tag counts an honest 0, not null', async () => {
    const page = await getGalleryPage(chatId, 'visual', `no-such-tag-${RUN_ID}`, null, 60);
    assert.deepEqual(page.items, []);
    assert.equal(page.totalCount, 0, 'null would render a rail of ghosts that can never fill');
    assert.equal(page.nextCursor, null);
  });

  test('respects the kind filter', async () => {
    const page = await getGalleryPage(chatId, 'voice', null, null, 60);
    assert.equal(page.items.length, 0, 'no voice media in this fixture');
    assert.equal(page.totalCount, 0);
  });
});
