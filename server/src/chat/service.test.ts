/**
 * Service-level tests for `editMessage` (docs/MESSAGE_EDIT.md §5). No test
 * harness existed in this repo yet (server's `test` script was a
 * "no tests yet" placeholder) — this exercises the service function directly
 * against the real dev Postgres (the docker-compose stack's `postgres`
 * service, same DB `npm run dev` talks to), the way the project's other
 * verification has so far been a scripted flow against that same stack
 * (PROJECT.md §16) rather than a mocked unit-test style. Every row this file
 * creates is scoped to a fresh, randomly-suffixed pair of users and torn
 * down in `after()`, so repeated runs never accumulate garbage in the shared
 * dev DB and never collide with each other.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, friendships, messages, users } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  createChat,
  editMessage,
  getMessagesPage,
  listReceipts,
  markDelivered,
  markRead,
  messageByClientNonce,
  parseClientNonce,
  sendTextMessage,
} from './service.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let userAId: bigint;
let userBId: bigint;
let chatId: bigint;

async function insertUser(suffix: string): Promise<bigint> {
  const username = `edit-test-${suffix}-${RUN_ID}`;
  const rows = await db.insert(users).values({ username, displayName: username }).returning({ id: users.id });
  return rows[0]!.id;
}

async function insertMessage(overrides: Partial<typeof messages.$inferInsert> = {}) {
  const rows = await db
    .insert(messages)
    .values({ chatId, senderId: userAId, kind: 'text', body: 'original body', ...overrides })
    .returning();
  return rows[0]!;
}

function statusOf(err: unknown): number | undefined {
  return err instanceof AppError ? err.statusCode : undefined;
}

before(async () => {
  userAId = await insertUser('a');
  userBId = await insertUser('b');
  const [lo, hi] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  const chatRows = await db
    .insert(chats)
    .values({ isGroup: false, dmKey: `${lo}:${hi}`, createdBy: userAId })
    .returning({ id: chats.id });
  chatId = chatRows[0]!.id;
  await db.insert(chatMembers).values([
    { chatId, userId: userAId },
    { chatId, userId: userBId },
  ]);
});

after(async () => {
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(inArray(users.id, [userAId, userBId]));
  await closeDb();
});

describe('editMessage', () => {
  test('happy path: the sender edits their own text message', async () => {
    const row = await insertMessage({ body: 'hello there' });
    const result = await editMessage(userAId, chatId, row.id, '  hello there, edited  ');
    assert.equal(result.changed, true);
    assert.equal(result.message.body, 'hello there, edited');
    assert.equal(result.message.id, row.id.toString());
    assert.ok(result.message.editedAt, 'editedAt should be set');
  });

  test('ownership: a non-sender editing someone else\'s message gets 403', async () => {
    const row = await insertMessage({ senderId: userAId, body: 'owned by A' });
    await assert.rejects(
      () => editMessage(userBId, chatId, row.id, 'attempted edit by B'),
      (err: unknown) => statusOf(err) === 403,
    );
  });

  test('a soft-deleted message is not editable (rejected)', async () => {
    const row = await insertMessage({ body: 'will be deleted' });
    await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, row.id));
    await assert.rejects(
      () => editMessage(userAId, chatId, row.id, 'nope'),
      (err: unknown) => {
        const status = statusOf(err);
        return status === 404 || status === 400;
      },
    );
  });

  test('no-op guard: an edit identical to the current body is skipped (changed: false)', async () => {
    const row = await insertMessage({ body: 'same body' });
    const result = await editMessage(userAId, chatId, row.id, '  same body  ');
    assert.equal(result.changed, false);
    assert.equal(result.message.body, 'same body');
    assert.equal(result.message.editedAt, null, 'a no-op edit must not stamp editedAt');
  });

  test('caption edit: a media (image) message\'s caption can be edited', async () => {
    const row = await insertMessage({ kind: 'image', body: 'original caption' });
    const result = await editMessage(userAId, chatId, row.id, 'new caption');
    assert.equal(result.changed, true);
    assert.equal(result.message.body, 'new caption');
    assert.equal(result.message.kind, 'image');
  });

  // Bonus coverage beyond the brief's required 5, cheap given the fixture
  // already exists:

  test('a nonexistent message id 404s', async () => {
    await assert.rejects(
      () => editMessage(userAId, chatId, 999999999999999n, 'x'),
      (err: unknown) => statusOf(err) === 404,
    );
  });

  test('a voice message cannot be edited (out of scope kind)', async () => {
    const row = await insertMessage({ kind: 'voice', body: 'caption-ish' });
    await assert.rejects(
      () => editMessage(userAId, chatId, row.id, 'nope'),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('an empty body is rejected (delete\'s job, not edit\'s)', async () => {
    const row = await insertMessage({ body: 'has a body' });
    await assert.rejects(
      () => editMessage(userAId, chatId, row.id, '   '),
      (err: unknown) => statusOf(err) === 400,
    );
  });
});

/**
 * Service-level tests for the receipts watermarks (docs/RECEIPTS.md §4.3/§7)
 * — same real-Postgres posture as `editMessage` above, with its own
 * self-contained fixture (a group chat + a foreign chat, both torn down in
 * `after()`) so these never depend on execution order against the
 * `editMessage` suite's rows.
 */
describe('markRead / markDelivered / listReceipts', () => {
  let senderId: bigint;
  let readerId: bigint;
  let receiptsChatId: bigint;
  let msg1: bigint;
  let msg2: bigint;
  let deletedMsgId: bigint;
  let foreignChatId: bigint;
  let foreignMsgId: bigint;

  before(async () => {
    senderId = await insertUser('receipts-sender');
    readerId = await insertUser('receipts-reader');

    const chatRows = await db
      .insert(chats)
      .values({ isGroup: true, name: 'receipts-test', createdBy: senderId })
      .returning({ id: chats.id });
    receiptsChatId = chatRows[0]!.id;
    await db.insert(chatMembers).values([
      { chatId: receiptsChatId, userId: senderId },
      { chatId: receiptsChatId, userId: readerId },
    ]);

    const m1 = await db.insert(messages).values({ chatId: receiptsChatId, senderId, kind: 'text', body: 'one' }).returning();
    msg1 = m1[0]!.id;
    const m2 = await db.insert(messages).values({ chatId: receiptsChatId, senderId, kind: 'text', body: 'two' }).returning();
    msg2 = m2[0]!.id;
    const del = await db
      .insert(messages)
      .values({ chatId: receiptsChatId, senderId, kind: 'text', body: 'deleted', deletedAt: new Date() })
      .returning();
    deletedMsgId = del[0]!.id;

    // A message that's real, but belongs to a *different* chat — proves the
    // guard rejects cross-chat ids, not just nonexistent ones.
    const foreignChatRows = await db
      .insert(chats)
      .values({ isGroup: true, name: 'receipts-foreign', createdBy: senderId })
      .returning({ id: chats.id });
    foreignChatId = foreignChatRows[0]!.id;
    await db.insert(chatMembers).values({ chatId: foreignChatId, userId: senderId });
    const fm = await db.insert(messages).values({ chatId: foreignChatId, senderId, kind: 'text', body: 'foreign' }).returning();
    foreignMsgId = fm[0]!.id;
  });

  after(async () => {
    // No `closeDb()` here — the module-level `after` above (which runs after
    // every describe in this file, editMessage included) owns closing the
    // shared connection pool exactly once.
    await db.delete(messages).where(inArray(messages.chatId, [receiptsChatId, foreignChatId]));
    await db.delete(chatMembers).where(inArray(chatMembers.chatId, [receiptsChatId, foreignChatId]));
    await db.delete(chats).where(inArray(chats.id, [receiptsChatId, foreignChatId]));
    await db.delete(users).where(inArray(users.id, [senderId, readerId]));
  });

  test('markRead advances the watermark forward, then guards against moving it backward (monotonic)', async () => {
    const first = await markRead(receiptsChatId, readerId, msg1);
    assert.equal(first, true, 'NULL -> msg1 should advance');
    const forward = await markRead(receiptsChatId, readerId, msg2);
    assert.equal(forward, true, 'msg1 -> msg2 should advance');
    const backward = await markRead(receiptsChatId, readerId, msg1);
    assert.equal(backward, false, 'msg2 -> msg1 must be a no-op, never move backward');
  });

  test('markDelivered is monotonic and tracks a watermark independent of markRead', async () => {
    const first = await markDelivered(receiptsChatId, readerId, msg1);
    assert.equal(first, true);
    const same = await markDelivered(receiptsChatId, readerId, msg1);
    assert.equal(same, false, 'repeating the same id is not "newer" — no-op');
    const forward = await markDelivered(receiptsChatId, readerId, msg2);
    assert.equal(forward, true);
  });

  test('markRead rejects a message id that belongs to a different chat', async () => {
    await assert.rejects(
      () => markRead(receiptsChatId, readerId, foreignMsgId),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('markRead rejects a soft-deleted message id', async () => {
    await assert.rejects(
      () => markRead(receiptsChatId, readerId, deletedMsgId),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('markRead rejects a nonexistent message id', async () => {
    await assert.rejects(
      () => markRead(receiptsChatId, readerId, 999999999999999n),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('markDelivered rejects the same invalid-id cases as markRead (foreign chat, soft-deleted)', async () => {
    await assert.rejects(
      () => markDelivered(receiptsChatId, readerId, foreignMsgId),
      (err: unknown) => statusOf(err) === 400,
    );
    await assert.rejects(
      () => markDelivered(receiptsChatId, readerId, deletedMsgId),
      (err: unknown) => statusOf(err) === 400,
    );
  });

  test('listReceipts returns every member\'s watermarks, with nulls for a member who has read/delivered nothing', async () => {
    const freshReaderId = await insertUser('receipts-fresh');
    await db.insert(chatMembers).values({ chatId: receiptsChatId, userId: freshReaderId });
    try {
      const receipts = await listReceipts(receiptsChatId);
      const row = receipts.find((r) => r.userId === freshReaderId.toString());
      assert.ok(row, 'expected a receipts row for every member, including one who never read/delivered anything');
      assert.equal(row!.lastReadMessageId, null);
      assert.equal(row!.lastDeliveredMessageId, null);
      // Sanity: the earlier tests' watermarks for `readerId` round-trip
      // through listReceipts as strings, not raw bigints.
      const readerRow = receipts.find((r) => r.userId === readerId.toString());
      assert.equal(typeof readerRow?.lastReadMessageId, 'string');
    } finally {
      await db
        .delete(chatMembers)
        .where(and(eq(chatMembers.chatId, receiptsChatId), eq(chatMembers.userId, freshReaderId)));
      await db.delete(users).where(eq(users.id, freshReaderId));
    }
  });
});

/**
 * Audit fixes 2026-11-18 (migration 018): idempotent `message.send`, hidden
 * unpublished uploads, and the DM-creation race. Own fixture: two accepted
 * friends whose DM is created BY the test (through `createChat`), torn down
 * in `after()`.
 */
describe('idempotent sends / pending uploads / DM race', () => {
  let aliceId: bigint;
  let bobId: bigint;
  let dmId: bigint;

  before(async () => {
    aliceId = await insertUser('nonce-alice');
    bobId = await insertUser('nonce-bob');
    const [lo, hi] = aliceId < bobId ? [aliceId, bobId] : [bobId, aliceId];
    await db.insert(friendships).values({ userA: lo, userB: hi, status: 'accepted', requestedBy: aliceId });
  });

  after(async () => {
    if (dmId !== undefined) {
      await db.delete(messages).where(eq(messages.chatId, dmId));
      await db.delete(chatMembers).where(eq(chatMembers.chatId, dmId));
      await db.delete(chats).where(eq(chats.id, dmId));
    }
    await db.delete(friendships).where(inArray(friendships.userA, [aliceId, bobId]));
    await db.delete(users).where(inArray(users.id, [aliceId, bobId]));
  });

  test('two concurrent DM creates return one chat; the loser gets created:false, not a 500', async () => {
    const [x, y] = await Promise.all([
      createChat(aliceId, { memberIds: [bobId.toString()] }),
      createChat(bobId, { memberIds: [aliceId.toString()] }),
    ]);
    assert.equal(x.chat.id, y.chat.id);
    assert.equal([x.created, y.created].filter(Boolean).length, 1, 'exactly one request creates the row');
    dmId = BigInt(x.chat.id);
  });

  test('parseClientNonce accepts a UUID and rejects junk', () => {
    assert.equal(parseClientNonce('3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60'), '3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60');
    assert.equal(parseClientNonce(undefined), null);
    assert.equal(parseClientNonce('short'), null);
    assert.equal(parseClientNonce('x'.repeat(65)), null);
    assert.equal(parseClientNonce('has spaces in it'), null);
  });

  test('re-sending the same nonce returns the original row instead of inserting a copy', async () => {
    const nonce = `nonce-${RUN_ID}`;
    const first = await sendTextMessage(dmId, aliceId, 'hello once', undefined, nonce);
    const second = await sendTextMessage(dmId, aliceId, 'hello once', undefined, nonce);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.message.id, first.message.id);
    const rows = await db.select().from(messages).where(and(eq(messages.senderId, aliceId), eq(messages.clientNonce, nonce)));
    assert.equal(rows.length, 1);
    assert.equal((await messageByClientNonce(dmId, aliceId, nonce))?.id, first.message.id);
  });

  test('nonces are per sender: the same string from another member is a different message', async () => {
    const nonce = `shared-${RUN_ID}`;
    const a = await sendTextMessage(dmId, aliceId, 'from alice', undefined, nonce);
    const b = await sendTextMessage(dmId, bobId, 'from bob', undefined, nonce);
    assert.equal(b.duplicate, false);
    assert.notEqual(a.message.id, b.message.id);
  });

  test('the nonce is exposed on history pages only to its own sender', async () => {
    const nonce = `visible-${RUN_ID}`;
    const sent = await sendTextMessage(dmId, aliceId, 'whose nonce', undefined, nonce);
    const asAlice = await getMessagesPage(dmId, null, 50, aliceId);
    const asBob = await getMessagesPage(dmId, null, 50, bobId);
    assert.equal(asAlice.messages.find((m) => m.id === sent.message.id)?.clientNonce, nonce);
    assert.equal(asBob.messages.find((m) => m.id === sent.message.id)?.clientNonce, undefined);
  });

  test('an unpublished upload is invisible to history, receipts and replies', async () => {
    const rows = await db
      .insert(messages)
      .values({ chatId: dmId, senderId: aliceId, kind: 'image', body: null, pendingUpload: true })
      .returning();
    const pending = rows[0]!;
    for (const viewer of [aliceId, bobId]) {
      const page = await getMessagesPage(dmId, null, 50, viewer);
      assert.ok(!page.messages.some((m) => m.id === pending.id.toString()), 'hidden from sender and members alike');
    }
    await assert.rejects(() => markRead(dmId, bobId, pending.id), (err: unknown) => statusOf(err) === 400);
    await assert.rejects(() => sendTextMessage(dmId, bobId, 'reply', pending.id), (err: unknown) => statusOf(err) === 400);
    await assert.rejects(() => editMessage(aliceId, dmId, pending.id, 'caption'), (err: unknown) => statusOf(err) === 404);
  });
});
