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
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, messages, users } from '../db/schema.js';
import { AppError } from '../errors.js';
import { editMessage } from './service.js';

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
