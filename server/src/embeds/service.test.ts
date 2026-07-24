/**
 * Service-level tests for the embed message-mint/resolve lifecycle
 * (docs/EMBEDS.md §4.3), against the real dev Postgres — same posture as
 * `chat/service.test.ts` (no mocking, throwaway rows torn down in
 * `after()`). `finalizeEmbed`'s resolver step makes a real outbound HTTPS
 * request to instagram.com; this sandbox has no route to the public
 * internet, so the resolver is expected to fail here — which is itself a
 * real assertion: a network failure must degrade to `status: 'failed'`
 * cleanly, never throw out of `finalizeEmbed` (CLAUDE.md: a bad/unreachable
 * URL must not crash the request that triggered it). A live pass with real
 * network access is needed to verify the 'ready' happy path end to end.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq, inArray } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, embeds, messages, users } from '../db/schema.js';
import { detectEmbedUrl, stripEmbedUrl } from '@den/shared';
import { createEmbedMessage, embedInfoForMessages, finalizeEmbed } from './service.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let userAId: bigint;
let userBId: bigint;
let chatId: bigint;

async function insertUser(suffix: string): Promise<bigint> {
  const username = `embed-test-${suffix}-${RUN_ID}`;
  const rows = await db.insert(users).values({ username, displayName: username }).returning({ id: users.id });
  return rows[0]!.id;
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
  // embeds → messages (FK, no cascade) → chat_members/chats → users, same
  // dependency order chat/service.test.ts uses.
  const msgRows = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
  if (msgRows.length > 0) await db.delete(embeds).where(inArray(embeds.messageId, msgRows.map((r) => r.id)));
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(inArray(users.id, [userAId, userBId]));
  await closeDb();
});

describe('shared/src/embeds.ts detectEmbedUrl + stripEmbedUrl', () => {
  test('recognizes a reel URL embedded in free text and strips it to a caption', () => {
    const detected = detectEmbedUrl('check this out https://www.instagram.com/reel/Cxyz123AbC/ so good');
    assert.ok(detected, 'expected a match');
    assert.equal(detected!.provider, 'instagram');
    assert.equal(detected!.providerRef, 'Cxyz123AbC');
    assert.equal(detected!.url, 'https://www.instagram.com/reel/Cxyz123AbC/');
    const caption = stripEmbedUrl('check this out https://www.instagram.com/reel/Cxyz123AbC/ so good', detected!);
    // stripEmbedUrl removes the exact matched substring and trims the ends
    // only — it deliberately does not collapse the resulting double space,
    // that's the caller's/renderer's call, not the shared detector's.
    assert.equal(caption, 'check this out  so good');
  });

  test('a bare link with nothing else becomes a null caption, not an empty string', () => {
    const detected = detectEmbedUrl('https://instagram.com/p/Cabc999/');
    assert.ok(detected);
    assert.equal(stripEmbedUrl('https://instagram.com/p/Cabc999/', detected!), null);
  });

  test('rejects lookalike hosts and non-IG URLs (SSRF-relevant allowlist)', () => {
    assert.equal(detectEmbedUrl('https://instagram.com.evil.example/reel/abc/'), null);
    assert.equal(detectEmbedUrl('https://example.com/reel/abc/'), null);
    assert.equal(detectEmbedUrl('just some plain text, no links here'), null);
  });
});

describe('createEmbedMessage + finalizeEmbed (live DB)', () => {
  test('mints a processing placeholder, then resolves to failed on an unreachable network (sandbox has no outbound internet)', async () => {
    const created = await createEmbedMessage(
      chatId,
      userAId,
      'instagram',
      'https://www.instagram.com/reel/Cxyz123AbC/',
      'Cxyz123AbC',
      'look at this',
    );

    assert.equal(created.message.kind, 'embed');
    assert.equal(created.message.body, 'look at this');
    assert.equal(created.chatId, chatId);
    assert.ok(created.message.embed, 'placeholder must carry an EmbedInfo');
    assert.equal(created.message.embed!.status, 'processing');
    assert.equal(created.message.embed!.provider, 'instagram');
    assert.equal(created.message.embed!.canonicalUrl, 'https://www.instagram.com/reel/Cxyz123AbC/');

    // embedInfoForMessages (the batch path getMessagesPage/searchMessages use)
    // must see the same processing row.
    const batchBefore = await embedInfoForMessages([BigInt(created.message.id)]);
    assert.equal(batchBefore.get(created.message.id)?.status, 'processing');

    const resolved = await finalizeEmbed(created.embedId);
    // No outbound network here — the resolver's safeFetch throws, which
    // finalizeEmbed swallows into a 'failed' row rather than crashing.
    assert.equal(resolved.embed?.status, 'failed');
    assert.equal(resolved.id, created.message.id);
    assert.equal(resolved.body, 'look at this', 'the caption is untouched by resolution');

    const batchAfter = await embedInfoForMessages([BigInt(created.message.id)]);
    assert.equal(batchAfter.get(created.message.id)?.status, 'failed');
  });

  test('a bare link (no caption) mints with a null body', async () => {
    const created = await createEmbedMessage(chatId, userBId, 'instagram', 'https://www.instagram.com/p/Cabc999/', 'Cabc999', null);
    assert.equal(created.message.body, null);
    assert.equal(created.message.senderId, userBId.toString());
  });
});
