/**
 * Service-level tests for the album mint / sensitivity derivation / fanout
 * race pieces of docs/MEDIA_ATTACHMENTS.md §4.4. Same posture as
 * chat/service.test.ts: exercised against the real dev Postgres (the
 * docker-compose stack's `postgres` service) and, where a real upload needs
 * to be HEAD-verified, the dev MinIO service too — no mocking. Every row this
 * file creates is scoped to a fresh, randomly-suffixed fixture and torn down
 * in `after()`.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, media, mediaTags, messages, tags, users } from '../db/schema.js';
import { AppError } from '../errors.js';
import { addTag } from './tags.js';
import { mediaKey, putObjectBuffer } from './r2.js';
import { completeUpload, createUpload, mediaInfoForMessages } from './service.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// A valid, decodable 1x1 transparent PNG — small enough to keep the test fast
// while still passing the real magic-number sniff completeUpload runs
// (CLAUDE.md #7: never trust client-declared mime/size).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let userId: bigint;
let otherId: bigint;
let chatId: bigint;

async function insertUser(suffix: string): Promise<bigint> {
  const username = `media-svc-test-${suffix}-${RUN_ID}`;
  const rows = await db.insert(users).values({ username, displayName: username }).returning({ id: users.id });
  return rows[0]!.id;
}

function statusOf(err: unknown): number | undefined {
  return err instanceof AppError ? err.statusCode : undefined;
}

/** Uploads a real tiny PNG to the exact key `completeUpload` will HEAD/sniff
 *  — same key scheme the mint step already computed. */
async function putRealObjectFor(mediaId: bigint): Promise<void> {
  await putObjectBuffer(mediaKey(chatId, mediaId, 'orig'), TINY_PNG, 'image/png');
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
});

after(async () => {
  const msgRows = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
  const msgIds = msgRows.map((r) => r.id);
  if (msgIds.length > 0) {
    const mediaRows = await db.select({ id: media.id }).from(media).where(inArray(media.messageId, msgIds));
    const mediaIds = mediaRows.map((r) => r.id);
    if (mediaIds.length > 0) await db.delete(mediaTags).where(inArray(mediaTags.mediaId, mediaIds));
    await db.delete(media).where(inArray(media.messageId, msgIds));
  }
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(tags).where(eq(tags.chatId, chatId)); // addTag's chat-registry rows (mediaTags already cleared above)
  await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(inArray(users.id, [userId, otherId]));
  await closeDb();
});

describe('createUpload (album mint)', () => {
  test('mints one message with N media rows, kind = the first item\'s kind, in request order', async () => {
    const result = await createUpload(
      chatId,
      userId,
      [
        { kind: 'image', mime: 'image/png', sizeBytes: 1000 },
        { kind: 'video', mime: 'video/mp4', sizeBytes: 2000 },
        { kind: 'image', mime: 'image/jpeg', sizeBytes: 3000 },
      ],
      'an album caption',
      undefined,
    );

    assert.equal(result.items.length, 3);
    const msgRows = await db.select().from(messages).where(eq(messages.id, result.messageId));
    assert.equal(msgRows[0]!.kind, 'image', 'message kind must be the FIRST item\'s kind');
    assert.equal(msgRows[0]!.body, 'an album caption');

    const mediaRows = await db.select().from(media).where(eq(media.messageId, result.messageId)).orderBy(media.id);
    assert.equal(mediaRows.length, 3);
    assert.deepEqual(
      mediaRows.map((r) => r.kind),
      ['image', 'video', 'image'],
      'media rows preserve request order',
    );
    // Each item's r2Key/mediaId pairing round-trips through the response in order.
    assert.deepEqual(
      mediaRows.map((r) => r.id),
      result.items.map((it) => it.mediaId),
    );
  });

  test('a single item still mints exactly one message + one media row (pre-album behavior)', async () => {
    const result = await createUpload(chatId, userId, [{ kind: 'image', mime: 'image/png', sizeBytes: 500 }], undefined, undefined);
    assert.equal(result.items.length, 1);
    const mediaRows = await db.select().from(media).where(eq(media.messageId, result.messageId));
    assert.equal(mediaRows.length, 1);
  });

  test('is all-or-nothing: one bad item rejects the whole batch, nothing is written', async () => {
    const beforeCount = (await db.select().from(messages).where(eq(messages.chatId, chatId))).length;

    await assert.rejects(
      () =>
        createUpload(
          chatId,
          userId,
          [
            { kind: 'image', mime: 'image/png', sizeBytes: 1000 },
            { kind: 'image', mime: 'image/png', sizeBytes: -5 }, // invalid: not positive
          ],
          undefined,
          undefined,
        ),
      (err: unknown) => statusOf(err) === 400,
    );

    const afterCount = (await db.select().from(messages).where(eq(messages.chatId, chatId))).length;
    assert.equal(afterCount, beforeCount, 'a rejected batch must not create a message row, even for the valid items');
  });

  test('rejects a batch over MediaLimits.maxAttachments (10)', async () => {
    const items = Array.from({ length: 11 }, () => ({ kind: 'image' as const, mime: 'image/png', sizeBytes: 100 }));
    await assert.rejects(
      () => createUpload(chatId, userId, items, undefined, undefined),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('rejects an empty items array', async () => {
    await assert.rejects(
      () => createUpload(chatId, userId, [], undefined, undefined),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('rejects an item over its kind\'s size ceiling', async () => {
    await assert.rejects(
      () => createUpload(chatId, userId, [{ kind: 'image', mime: 'image/png', sizeBytes: 26 * 1024 * 1024 }], undefined, undefined),
      (err: unknown) => statusOf(err) === 400,
    );
  });
});

describe('sensitivity derivation (mediaInfoForMessages)', () => {
  async function insertBareMediaRow(): Promise<{ messageId: bigint; mediaId: bigint }> {
    const msgRows = await db.insert(messages).values({ chatId, senderId: userId, kind: 'image', body: null }).returning();
    const messageRow = msgRows[0]!;
    const mediaRows = await db
      .insert(media)
      .values({
        messageId: messageRow.id,
        uploaderId: userId,
        kind: 'image',
        r2Key: `media/${chatId}/sensitivity-test/${messageRow.id}`,
        mime: 'image/png',
        sizeBytes: 10n,
      })
      .returning();
    return { messageId: messageRow.id, mediaId: mediaRows[0]!.id };
  }

  test('null when no sensitive tags are attached', async () => {
    const { messageId, mediaId } = await insertBareMediaRow();
    await addTag(chatId, mediaId, userId, 'beach');

    const map = await mediaInfoForMessages([messageId]);
    const list = map.get(messageId.toString());
    assert.ok(list);
    assert.equal(list![0]!.sensitivity, null);
  });

  test('spoiler tag alone yields sensitivity "spoiler"', async () => {
    const { messageId, mediaId } = await insertBareMediaRow();
    await addTag(chatId, mediaId, userId, 'spoiler');

    const map = await mediaInfoForMessages([messageId]);
    assert.equal(map.get(messageId.toString())![0]!.sensitivity, 'spoiler');
  });

  test('nsfw wins when both nsfw and spoiler tags are attached', async () => {
    const { messageId, mediaId } = await insertBareMediaRow();
    await addTag(chatId, mediaId, userId, 'spoiler');
    await addTag(chatId, mediaId, userId, 'nsfw');

    const map = await mediaInfoForMessages([messageId]);
    assert.equal(map.get(messageId.toString())![0]!.sensitivity, 'nsfw');
  });

  test('mediaInfoForMessages orders an album\'s media by id ASC', async () => {
    const result = await createUpload(
      chatId,
      userId,
      [
        { kind: 'image', mime: 'image/png', sizeBytes: 100 },
        { kind: 'image', mime: 'image/png', sizeBytes: 100 },
        { kind: 'image', mime: 'image/png', sizeBytes: 100 },
      ],
      undefined,
      undefined,
    );
    const map = await mediaInfoForMessages([result.messageId]);
    const list = map.get(result.messageId.toString())!;
    assert.equal(list.length, 3);
    const ids = list.map((m) => BigInt(m.id));
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(ids, sorted, 'media must come back sorted by id ASC');
  });
});

describe('completeUpload fanout race (docs/MEDIA_ATTACHMENTS.md §4.4)', () => {
  test('sequential completes: only the FIRST item to complete gets isFirstComplete=true', async () => {
    const result = await createUpload(
      chatId,
      userId,
      [
        { kind: 'image', mime: 'image/png', sizeBytes: TINY_PNG.length },
        { kind: 'image', mime: 'image/png', sizeBytes: TINY_PNG.length },
      ],
      undefined,
      undefined,
    );
    const [item1, item2] = result.items;
    await putRealObjectFor(item1!.mediaId);
    await putRealObjectFor(item2!.mediaId);

    const first = await completeUpload(item1!.mediaId, userId, undefined);
    assert.equal(first.isFirstComplete, true);

    const second = await completeUpload(item2!.mediaId, userId, undefined);
    assert.equal(second.isFirstComplete, false);

    // Both completions' returned message carry EVERY sibling media item —
    // the "media.ready replaces the message wholesale" contract.
    assert.equal(first.message.media.length, 2);
    assert.equal(second.message.media.length, 2);
  });

  test('two near-simultaneous completes of sibling items: exactly one wins isFirstComplete', async () => {
    const result = await createUpload(
      chatId,
      userId,
      [
        { kind: 'image', mime: 'image/png', sizeBytes: TINY_PNG.length },
        { kind: 'image', mime: 'image/png', sizeBytes: TINY_PNG.length },
      ],
      undefined,
      undefined,
    );
    const [item1, item2] = result.items;
    await Promise.all([putRealObjectFor(item1!.mediaId), putRealObjectFor(item2!.mediaId)]);

    const [a, b] = await Promise.all([
      completeUpload(item1!.mediaId, userId, undefined),
      completeUpload(item2!.mediaId, userId, undefined),
    ]);

    const winners = [a.isFirstComplete, b.isFirstComplete].filter(Boolean).length;
    assert.equal(winners, 1, 'exactly one of the two near-simultaneous completes must win message.new');
  });

  test('a single-media message always wins isFirstComplete (pre-album behavior preserved)', async () => {
    const result = await createUpload(chatId, userId, [{ kind: 'image', mime: 'image/png', sizeBytes: TINY_PNG.length }], undefined, undefined);
    const item = result.items[0]!;
    await putRealObjectFor(item.mediaId);

    const completed = await completeUpload(item.mediaId, userId, undefined);
    assert.equal(completed.isFirstComplete, true);
  });

  test('tags passed to completeUpload are attached before the returned message is built', async () => {
    const result = await createUpload(chatId, userId, [{ kind: 'image', mime: 'image/png', sizeBytes: TINY_PNG.length }], undefined, undefined);
    const item = result.items[0]!;
    await putRealObjectFor(item.mediaId);

    const completed = await completeUpload(item.mediaId, userId, ['nsfw', 'beach']);
    assert.equal(completed.message.media.length, 1);
    assert.equal(completed.message.media[0]!.sensitivity, 'nsfw', 'nsfw tag from the complete call must already be reflected');
  });
});
