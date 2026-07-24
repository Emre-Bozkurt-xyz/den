/**
 * Pure unit tests for `deriveReceipts` (docs/RECEIPTS.md §3/§7) — no DOM, no
 * network, no DB; mirrors the plain `node:test` + `tsx` setup
 * `server/src/chat/service.test.ts` already uses, just pointed at a pure
 * function instead of the live dev Postgres.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ChatReceipt, Message, PublicUser } from '@den/shared';
import { deriveReceipts } from './receipts';

const ME = '10';
const ALICE = '20';
const BOB = '30';

function user(id: string, name: string): PublicUser {
  return { id, username: name.toLowerCase(), displayName: name, avatarUrl: null };
}

function msg(id: string, senderId: string): Message {
  return {
    id,
    chatId: '1',
    senderId,
    kind: 'text',
    body: `msg ${id}`,
    createdAt: new Date().toISOString(),
    media: null,
    embed: null,
    replyTo: null,
    reactions: [],
    editedAt: null,
  };
}

function receipt(userId: string, lastRead: string | null, lastDelivered: string | null): ChatReceipt {
  return { userId, lastReadMessageId: lastRead, lastDeliveredMessageId: lastDelivered };
}

const members = [user(ME, 'Me'), user(ALICE, 'Alice'), user(BOB, 'Bob')];

describe('deriveReceipts', () => {
  test('watermark clamp: a seen avatar sits on the newest of my messages the reader has actually reached, not any later one', () => {
    // Alice's watermark (102) sits between my 2nd and 3rd message — her
    // avatar must land on 102, not the truly-newest 103, and not on 100.
    const messages = [msg('100', ME), msg('101', ALICE), msg('102', ME), msg('103', ME)];
    const receipts = [receipt(ME, null, null), receipt(ALICE, '102', null)];

    const { seenAvatars } = deriveReceipts(messages, receipts, members, ME);

    assert.deepEqual(seenAvatars.get('102')?.map((u) => u.id), [ALICE]);
    assert.equal(seenAvatars.get('103'), undefined);
    assert.equal(seenAvatars.get('100'), undefined);
  });

  test('all-others rule: Delivered only once every other member has delivered the newest message; one holdout keeps it at Sent', () => {
    const messages = [msg('200', ME)];

    const partial = deriveReceipts(
      messages,
      [receipt(ME, null, null), receipt(ALICE, null, '200'), receipt(BOB, null, null)], // Bob hasn't delivered yet
      members,
      ME,
    );
    assert.deepEqual(partial.status, { messageId: '200', kind: 'sent' });

    const all = deriveReceipts(
      messages,
      [receipt(ME, null, null), receipt(ALICE, null, '200'), receipt(BOB, null, '200')],
      members,
      ME,
    );
    assert.deepEqual(all.status, { messageId: '200', kind: 'delivered' });
  });

  test('suppression rule: once the newest message has ≥1 seen avatar, the Sent/Delivered text is suppressed entirely', () => {
    const messages = [msg('300', ME)];
    const receipts = [
      receipt(ME, null, null),
      receipt(ALICE, '300', '300'), // Alice has read it (implies delivered)
      receipt(BOB, null, '300'),
    ];

    const { status, seenAvatars } = deriveReceipts(messages, receipts, members, ME);

    assert.ok((seenAvatars.get('300')?.length ?? 0) > 0, 'expected a seen avatar on the newest message');
    assert.equal(status, null, 'status text must be suppressed once an avatar is showing');
  });

  test('a local (pending:/failed:) bubble is never the "newest mine" for status or seen-avatar purposes', () => {
    const messages = [msg('400', ME), msg('pending:abc', ME)];
    const receipts = [receipt(ME, null, null), receipt(ALICE, '400', '400')];

    const { status } = deriveReceipts(messages, receipts, members, ME);

    // The real newest-of-mine is 400, which Alice has already seen — so
    // status is suppressed, not computed off the still-local 'pending:abc'.
    assert.equal(status, null);
  });

  test("the viewer's own receipts row never contributes a seen avatar, even if it's watermarked past the message", () => {
    const messages = [msg('500', ME)];
    const receipts = [receipt(ME, '500', '500')];

    const { seenAvatars, status } = deriveReceipts(messages, receipts, members, ME);

    assert.equal(seenAvatars.size, 0);
    assert.deepEqual(status, { messageId: '500', kind: 'sent' });
  });

  test('no status when I have no real messages in the loaded page', () => {
    const messages = [msg('600', ALICE)];
    const { status, seenAvatars } = deriveReceipts(messages, [], members, ME);
    assert.equal(status, null);
    assert.equal(seenAvatars.size, 0);
  });

  // ── reply-supersedes-receipt (owner revision 2026-07-23, RECEIPTS.md §3) ──

  test("reply supersedes seen: a member's own later message drops their marker AND the status text", () => {
    // my 700 → Alice reads it (watermark 700) → Alice replies 701. Her reply
    // is proof enough; no marker under 700, and no stale "Delivered" either.
    const messages = [msg('700', ME), msg('701', ALICE)];
    const receipts = [receipt(ME, null, null), receipt(ALICE, '700', '700'), receipt(BOB, '700', '700')];

    const { seenAvatars, status } = deriveReceipts(messages, receipts, members, ME);

    assert.equal(seenAvatars.get('700')?.some((u) => u.id === ALICE) ?? false, false, "Alice's marker must be dropped");
    assert.equal(status, null, 'status must stay suppressed (she effectively saw it)');
  });

  test("per-member suppression: B's reply does not hide C's read marker in a group", () => {
    // my 800 → Alice replies 801, Bob only reads (watermark 800, no reply).
    // Alice's marker goes; Bob's stays — his avatar is the only evidence.
    const messages = [msg('800', ME), msg('801', ALICE)];
    const receipts = [receipt(ME, null, null), receipt(ALICE, '801', '801'), receipt(BOB, '800', '800')];

    const { seenAvatars } = deriveReceipts(messages, receipts, members, ME);

    assert.deepEqual(seenAvatars.get('800')?.map((u) => u.id), [BOB]);
  });

  test('sending implies seeing: a later reply suppresses status even when the watermark lags behind it', () => {
    // Alice's markRead raced/failed (watermark null) but her reply 901 is
    // loaded — my 900 must not show "Sent" as if she never saw it.
    const messages = [msg('900', ME), msg('901', ALICE)];
    const receipts = [receipt(ME, null, null), receipt(ALICE, null, null)];

    const { status, seenAvatars } = deriveReceipts(messages, receipts, [user(ME, 'Me'), user(ALICE, 'Alice')], ME);

    assert.equal(status, null, 'her reply counts as effectively seen');
    assert.equal(seenAvatars.size, 0, 'no marker either — nothing to place from a null watermark');
  });

  test('a marker newer than their last reply still renders: reply then read-further keeps the receipt visible', () => {
    // Alice replies 1001, then reads my later 1002 (watermark 1002) without
    // replying again — her marker belongs on 1002 and must survive.
    const messages = [msg('1000', ME), msg('1001', ALICE), msg('1002', ME)];
    const receipts = [receipt(ME, null, null), receipt(ALICE, '1002', '1002')];

    const { seenAvatars } = deriveReceipts(messages, receipts, members, ME);

    assert.deepEqual(seenAvatars.get('1002')?.map((u) => u.id), [ALICE]);
  });
});
