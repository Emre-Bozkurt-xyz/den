/**
 * Chat ↔ Vault-group membership mirror (docs/EMBEDS.md §6.3). One Vault
 * group per chat, created lazily on first Stage use, owned/administered by
 * Den's service principal (`env.vaultServiceToken`) so document ownership
 * survives any member leaving. Den mirrors ONE membership list per chat —
 * not per-doc grants — keeping only LINKED chat members as Vault group
 * members (an unlinked member has no Vault identity to add).
 *
 * No shared transaction spans Den and Vault (§6.3): every write here is
 * retryable and none of it may roll back or block the Den-side action that
 * triggered it. Two different failure postures live in this file:
 *
 *   - `ensureChatGroupMembership` is a SYNCHRONOUS HARD PRECONDITION of the
 *     Stage add-flow (server/src/routes/stage.ts, docs/EMBEDS.md §7.1 item
 *     1): Vault's clone check 6 requires the acting user already be a group
 *     member, and failure there is an opaque 404. So THIS function's errors
 *     are allowed to propagate — the caller needs to know before it wastes
 *     a clone/create call against a group the user isn't in.
 *   - Everything reached from the four background triggers (§6.3: join,
 *     link, leave, unlink) is best-effort — callers MUST catch and log
 *     rather than let a Vault outage block the Den-side action (joining a
 *     chat must still succeed if Vault is down). `reconcileChatGroup` is the
 *     backstop sweep for whatever a failed/missed trigger left inconsistent.
 *
 * ⚠️ Known gap (found while implementing, not in the original plan): the
 * Vault surface we were handed (integrations/vaultClient.ts) has no "list
 * group members" endpoint, only add/remove. That means `reconcileChatGroup`
 * can only RE-ASSERT membership for everyone who should currently be a
 * member (self-healing a missed/failed *add*) — it has no way to discover
 * and prune a stray member Vault still has on file (a missed/failed
 * *remove*), because Den has no record of who used to be linked once their
 * `vault_links` row is gone. Real-time removal therefore depends on the
 * leave/unlink triggers firing at the moment they happen (this file captures
 * `vaultUserId` before it's lost); the sweep cannot recover a removal that
 * both failed AND was never retried. See the executor report.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chatMembers, chats, chatVaultGroups, users, vaultLinks } from '../db/schema.js';
import { env } from '../env.js';
import { validation } from '../errors.js';
import { addVaultGroupMember, createVaultGroup, removeVaultGroupMember } from '../integrations/vaultClient.js';

interface LinkedMember {
  userId: bigint;
  vaultUserId: string;
}

async function linkedMembersOf(chatId: bigint): Promise<LinkedMember[]> {
  return db
    .select({ userId: chatMembers.userId, vaultUserId: vaultLinks.vaultUserId })
    .from(chatMembers)
    .innerJoin(vaultLinks, eq(vaultLinks.userId, chatMembers.userId))
    .where(eq(chatMembers.chatId, chatId));
}

async function chatGroupIdIfExists(chatId: bigint): Promise<string | null> {
  const rows = await db
    .select({ vaultGroupId: chatVaultGroups.vaultGroupId })
    .from(chatVaultGroups)
    .where(eq(chatVaultGroups.chatId, chatId))
    .limit(1);
  return rows[0]?.vaultGroupId ?? null;
}

/** A human-legible Vault group name (docs/EMBEDS.md §6.3: "Name the group
 *  after the chat"). Falls back to member display names for a DM (no
 *  `chats.name`), and to a bare id if even that comes back empty. This is
 *  purely a label linked members see in their own Vault dashboard — never
 *  parsed, never shown in Den's own UI. */
async function chatDisplayName(chatId: bigint): Promise<string> {
  const chatRows = await db.select({ name: chats.name }).from(chats).where(eq(chats.id, chatId)).limit(1);
  const name = chatRows[0]?.name;
  if (name) return name;

  const memberRows = await db
    .select({ displayName: users.displayName })
    .from(chatMembers)
    .innerJoin(users, eq(users.id, chatMembers.userId))
    .where(eq(chatMembers.chatId, chatId));
  const joined = memberRows.map((r) => r.displayName).join(' & ');
  return joined || `Chat ${chatId}`;
}

/** Returns the chat's Vault group id, creating the Vault group + the
 *  `chat_vault_groups` row on first use and seeding it with the chat's
 *  currently-linked members (docs/EMBEDS.md §6.3). Idempotent — a second
 *  call for a chat that already has a group just returns the existing id. */
export async function ensureChatGroup(chatId: bigint): Promise<string> {
  const existing = await chatGroupIdIfExists(chatId);
  if (existing) return existing;

  if (!env.vaultServiceToken) {
    // Matches StageResponse.writable's contract (docs/EMBEDS.md §7.1 item 2):
    // no service token degrades the Stage to read-only, never a boot crash.
    throw validation('Vault service token is not configured; the Stage is read-only');
  }

  const name = await chatDisplayName(chatId);
  const vaultGroupId = await createVaultGroup(`Den: ${name}`);

  // Race guard: two concurrent first-uses could both reach here and both
  // create a Vault group. The chatId primary key lets only one insert win;
  // the loser adopts the winner's row rather than registering its own
  // (now-orphaned) group id. We can't delete a Vault group through this
  // client, so the loser's group is harmless dead weight on Vault's side,
  // never referenced by Den.
  const inserted = await db
    .insert(chatVaultGroups)
    .values({ chatId, vaultGroupId })
    .onConflictDoNothing({ target: chatVaultGroups.chatId })
    .returning({ vaultGroupId: chatVaultGroups.vaultGroupId });

  if (inserted.length === 0) {
    const winner = await chatGroupIdIfExists(chatId);
    if (winner) return winner;
    // Extremely unlikely (the row we just lost the race for would have to
    // vanish between the conflict and this re-read) — fall back to our own
    // group rather than throwing.
    return vaultGroupId;
  }

  // Seed with everyone currently linked — best-effort per member so one
  // add failure doesn't undo the group creation that already succeeded.
  const linked = await linkedMembersOf(chatId);
  await Promise.all(
    linked.map((m) =>
      addVaultGroupMember(vaultGroupId, m.vaultUserId).catch((err) => {
        console.error(
          `vaultGroups: seed-add failed chat=${chatId} user=${m.userId}:`,
          err instanceof Error ? err.message : err,
        );
      }),
    ),
  );

  return vaultGroupId;
}

/** Hard precondition for the Stage add-flow (docs/EMBEDS.md §7.1 item 1) —
 *  ensures the chat's group exists, then adds `userId` to it IF they're
 *  linked. An unlinked `userId` gets the group ensured but no membership
 *  added (there's no Vault identity to add); callers that need a linked
 *  viewer reject that case themselves before this matters (Stage's add-flow
 *  requires the viewer's own OAuth token for the clone/portal step anyway).
 *  Unlike the trigger helpers below, failures here propagate. */
export async function ensureChatGroupMembership(chatId: bigint, userId: bigint): Promise<string> {
  const groupId = await ensureChatGroup(chatId);
  const link = await db
    .select({ vaultUserId: vaultLinks.vaultUserId })
    .from(vaultLinks)
    .where(eq(vaultLinks.userId, userId))
    .limit(1);
  if (link[0]) await addVaultGroupMember(groupId, link[0].vaultUserId);
  return groupId;
}

/** Targeted add (trigger 1 "user joins a chat" / trigger 2 "member links
 *  Vault"). No-op — no Vault call at all — when the chat has no group yet
 *  (nothing to add to; a group seeds its own current members the moment
 *  it's first created, see `ensureChatGroup`) or when `userId` isn't linked
 *  (no Vault identity to add). Safe to call unconditionally from either
 *  trigger site. */
export async function addMemberToChatGroup(chatId: bigint, userId: bigint): Promise<void> {
  const groupId = await chatGroupIdIfExists(chatId);
  if (!groupId) return;
  const link = await db
    .select({ vaultUserId: vaultLinks.vaultUserId })
    .from(vaultLinks)
    .where(eq(vaultLinks.userId, userId))
    .limit(1);
  if (!link[0]) return;
  await addVaultGroupMember(groupId, link[0].vaultUserId);
}

/** Targeted remove (trigger 3 "user leaves a chat" / trigger 4 "user
 *  unlinks Vault"). `vaultUserId` is passed explicitly rather than looked
 *  up — the unlink trigger fires when the `vault_links` row is already gone,
 *  so every caller must capture it beforehand (see
 *  `removeUnlinkedUserFromAllChatGroups` below). No-op when the chat has no
 *  group. */
export async function removeMemberFromChatGroup(chatId: bigint, vaultUserId: string): Promise<void> {
  const groupId = await chatGroupIdIfExists(chatId);
  if (!groupId) return;
  await removeVaultGroupMember(groupId, vaultUserId);
}

/** Trigger 2 (docs/EMBEDS.md §6.3): "the already-in-the-chat, links-later
 *  case — the link callback must walk the user's chats." Adds `userId` to
 *  every chat-group they're already a member of; each chat is independent
 *  best-effort (one failure doesn't stop the rest). Callers (the
 *  `/integrations/vault/callback` route) must still catch/log this promise
 *  themselves — it never blocks the OAuth redirect. */
export async function addLinkedUserToExistingChatGroups(userId: bigint): Promise<void> {
  const rows = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId));
  await Promise.all(
    rows.map((r) =>
      addMemberToChatGroup(r.chatId, userId).catch((err) => {
        console.error(
          `vaultGroups: link-sync add failed chat=${r.chatId} user=${userId}:`,
          err instanceof Error ? err.message : err,
        );
      }),
    ),
  );
}

/** Trigger 4 (docs/EMBEDS.md §6.3): a user just unlinked Vault — remove them
 *  from every chat group they were in. `vaultUserId` MUST be captured by the
 *  caller before `vault_links` is deleted (the row backing it is already
 *  gone by the time anything here could look it up). */
export async function removeUnlinkedUserFromAllChatGroups(userId: bigint, vaultUserId: string): Promise<void> {
  const rows = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId));
  await Promise.all(
    rows.map((r) =>
      removeMemberFromChatGroup(r.chatId, vaultUserId).catch((err) => {
        console.error(
          `vaultGroups: unlink-sync remove failed chat=${r.chatId} user=${userId}:`,
          err instanceof Error ? err.message : err,
        );
      }),
    ),
  );
}

/** Idempotent full sweep (docs/EMBEDS.md §6.3) — the backstop for a missed
 *  event or a failed Vault call. No-op when the chat has no Stage group yet.
 *  Re-asserts (idempotent add, per the Vault contract) every currently
 *  linked chat member — self-healing a missed/failed *add*. See the file
 *  header for why this can't also prune a stray member: the client we were
 *  given has no "list group members" call to diff against. */
export async function reconcileChatGroup(chatId: bigint): Promise<void> {
  const groupId = await chatGroupIdIfExists(chatId);
  if (!groupId) return;

  const linked = await linkedMembersOf(chatId);
  await Promise.all(
    linked.map((m) =>
      addVaultGroupMember(groupId, m.vaultUserId).catch((err) => {
        console.error(
          `vaultGroups: reconcile add failed chat=${chatId} user=${m.userId}:`,
          err instanceof Error ? err.message : err,
        );
      }),
    ),
  );
}
