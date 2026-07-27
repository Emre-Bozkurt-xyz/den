/**
 * Tests for the chat ↔ Vault-group membership mirror (docs/EMBEDS.md §6.3),
 * against the real dev Postgres — same throwaway-row posture as
 * `integrations/vaultLinks.test.ts` and `embeds/service.test.ts`.
 *
 * This sandbox has no route to a live Vault (same constraint noted in
 * embeds/service.test.ts) AND no `VAULT_SERVICE_TOKEN` configured (checked:
 * neither the repo root `.env` nor compose set it), so `createVaultGroup`
 * can never be reached from here — `ensureChatGroup` fails fast on the
 * missing token before it would ever make a network call. That constrains
 * what "idempotent" can mean in this environment: the tests below exercise
 * every no-op guard in vaultGroups.ts that is reachable WITHOUT a live
 * Vault group (no-group-yet, and unlinked-user, short-circuits — both
 * checked before any Vault HTTP call is made), calling each twice and
 * asserting identical, side-effect-free results. The "add/remove an actual
 * Vault group member twice" case needs a live Vault pass — see the executor
 * report.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { chatMembers, chats, chatVaultGroups, users, vaultLinks } from '../db/schema.js';
import { AppError } from '../errors.js';
import {
  addMemberToChatGroup,
  ensureChatGroup,
  ensureChatGroupMembership,
  reconcileChatGroup,
  removeMemberFromChatGroup,
} from './vaultGroups.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let userAId: bigint; // linked
let userBId: bigint; // never linked
let chatId: bigint;

async function insertUser(suffix: string): Promise<bigint> {
  const username = `vault-groups-test-${suffix}-${RUN_ID}`;
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
  // userA "links" Vault — a synthetic row, exactly like vaultLinks.test.ts's
  // direct-insert posture (no real OAuth round trip in this sandbox).
  await db.insert(vaultLinks).values({
    userId: userAId,
    vaultUserId: `vault-user-${RUN_ID}`,
    accessTokenEnc: 'unused-in-this-suite',
    refreshTokenEnc: 'unused-in-this-suite',
    expiresAt: new Date(Date.now() + 3600_000),
  });
});

after(async () => {
  await db.delete(chatVaultGroups).where(eq(chatVaultGroups.chatId, chatId));
  await db.delete(vaultLinks).where(eq(vaultLinks.userId, userAId));
  await db.delete(chatMembers).where(eq(chatMembers.chatId, chatId));
  await db.delete(chats).where(eq(chats.id, chatId));
  await db.delete(users).where(eq(users.id, userAId));
  await db.delete(users).where(eq(users.id, userBId));
  await closeDb();
});

describe('vaultGroups.ts idempotency (live DB, no live Vault in this sandbox)', () => {
  test('ensureChatGroup fails clean (not a raw network error) with no VAULT_SERVICE_TOKEN, and never leaves a partial row — called twice, same result both times, no group row created', async () => {
    await assert.rejects(() => ensureChatGroup(chatId), (err: unknown) => {
      assert.ok(err instanceof AppError, 'expected an AppError, not a raw fetch/network error');
      assert.equal((err as AppError).code, 'validation');
      return true;
    });
    // Second call: identical failure, not a different error from a half-
    // written row on the first attempt.
    await assert.rejects(() => ensureChatGroup(chatId), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).code, 'validation');
      return true;
    });

    const rows = await db.select().from(chatVaultGroups).where(eq(chatVaultGroups.chatId, chatId));
    assert.equal(rows.length, 0, 'a failed ensureChatGroup must not leave a chat_vault_groups row behind');
  });

  test('ensureChatGroupMembership propagates the same failure (it calls ensureChatGroup first)', async () => {
    await assert.rejects(() => ensureChatGroupMembership(chatId, userAId), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).code, 'validation');
      return true;
    });
  });

  test('addMemberToChatGroup no-ops when the chat has no Vault group yet — safe to call twice, resolves both times, no row created', async () => {
    await addMemberToChatGroup(chatId, userAId);
    await addMemberToChatGroup(chatId, userAId);

    const rows = await db.select().from(chatVaultGroups).where(eq(chatVaultGroups.chatId, chatId));
    assert.equal(rows.length, 0, 'still no group — nothing to add to');
  });

  test('removeMemberFromChatGroup no-ops when the chat has no Vault group — safe to call twice', async () => {
    await removeMemberFromChatGroup(chatId, 'some-vault-user-id');
    await removeMemberFromChatGroup(chatId, 'some-vault-user-id');
    // No assertion beyond "did not throw" — there is nothing to observe
    // when there was never a group.
  });

  test('reconcileChatGroup no-ops when the chat has no Vault group — safe to call twice', async () => {
    await reconcileChatGroup(chatId);
    await reconcileChatGroup(chatId);
  });

  test('addMemberToChatGroup no-ops for an unlinked user even once a group row exists — the link check short-circuits before any Vault call', async () => {
    // Simulate a chat that already has a group (bypassing ensureChatGroup's
    // real Vault call, which this sandbox can't reach) so we can exercise
    // the SECOND guard — "is this user linked" — in isolation. userB has no
    // vault_links row.
    const fakeGroupId = `fake-group-${RUN_ID}`;
    await db.insert(chatVaultGroups).values({ chatId, vaultGroupId: fakeGroupId });
    try {
      await addMemberToChatGroup(chatId, userBId);
      await addMemberToChatGroup(chatId, userBId);
      // Reaching here without throwing proves the unlinked-user short
      // circuit fired both times — an actual Vault call (unreachable host)
      // would have rejected instead.
    } finally {
      await db.delete(chatVaultGroups).where(eq(chatVaultGroups.chatId, chatId));
    }
  });
});
