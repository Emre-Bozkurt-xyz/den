/**
 * `vault_links` DB access (docs/EMBEDS.md §5.1). Tokens are encrypted at rest
 * (integrations/crypto.ts) the moment they're written and decrypted only
 * right before a Vault-bound request needs them — never handed to a route
 * handler's response, ever.
 */
import { eq } from 'drizzle-orm';
import type { VaultStatusResponse } from '@den/shared';
import { db } from '../db/index.js';
import { vaultLinkingEnabled } from '../env.js';
import { vaultLinks } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { refreshVaultToken, type VaultTokenResponse } from './vaultClient.js';

export async function upsertVaultLink(userId: bigint, vaultUserId: string, tokens: VaultTokenResponse): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await db
    .insert(vaultLinks)
    .values({
      userId,
      vaultUserId,
      accessTokenEnc: encryptSecret(tokens.access_token),
      // Vault's refresh may be omitted on a refresh-grant response that
      // didn't rotate it — fall back to encrypting nothing new only if we
      // truly have nothing (callers on the initial link always have one).
      refreshTokenEnc: encryptSecret(tokens.refresh_token ?? ''),
      expiresAt,
      scope: tokens.scope ?? null,
    })
    .onConflictDoUpdate({
      target: vaultLinks.userId,
      set: {
        vaultUserId,
        accessTokenEnc: encryptSecret(tokens.access_token),
        // A refresh grant that omitted a new refresh_token means the old one
        // is still valid (rotating-refresh servers that DO rotate always
        // send a new one) — don't overwrite a real token with an empty one.
        ...(tokens.refresh_token ? { refreshTokenEnc: encryptSecret(tokens.refresh_token) } : {}),
        expiresAt,
        scope: tokens.scope ?? null,
      },
    });
}

export async function deleteVaultLink(userId: bigint): Promise<void> {
  await db.delete(vaultLinks).where(eq(vaultLinks.userId, userId));
}

interface VaultLinkRow {
  vaultUserId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  expiresAt: Date;
}

async function vaultLinkRow(userId: bigint): Promise<VaultLinkRow | null> {
  const rows = await db
    .select({
      vaultUserId: vaultLinks.vaultUserId,
      accessTokenEnc: vaultLinks.accessTokenEnc,
      refreshTokenEnc: vaultLinks.refreshTokenEnc,
      expiresAt: vaultLinks.expiresAt,
    })
    .from(vaultLinks)
    .where(eq(vaultLinks.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** GET /integrations/vault/status. `vaultDisplayName` is intentionally not
 *  stored on the row (§5.1's schema has no display-name column) — Phase 2
 *  has nowhere else to source it from without another live Vault call, so it
 *  reports the linked Vault user id instead until Phase 3's metadata calls
 *  give a place to cache a real display name. */
export async function vaultStatus(userId: bigint): Promise<VaultStatusResponse> {
  const row = await vaultLinkRow(userId);
  return { linked: row !== null, vaultDisplayName: row?.vaultUserId ?? null };
}

/** Returns a currently-valid access token, refreshing first if it's expired
 *  (or about to be, within a 30s skew buffer) — docs/EMBEDS.md §5.1. Returns
 *  null when there's no link, or when the refresh itself fails/is revoked;
 *  a failed refresh deletes the row rather than leaving a row with a stale
 *  token, so `vaultStatus` immediately reports `linked: false` and the UI
 *  can prompt a re-link (the doc's "mark link broken, prompt re-link" — this
 *  schema (§5.1) has no separate broken/valid flag, so "unlinked" doubles as
 *  "broken", which is the same user-facing outcome). Not called by any route
 *  yet in Phase 1/2 (no embed provider reads Vault docs until Phase 3) — it
 *  exists now so Phase 3/4 don't have to re-derive this refresh dance. */
export async function getValidVaultAccessToken(userId: bigint): Promise<string | null> {
  // No encryption key configured ⇒ nothing stored can be decrypted. Return
  // null (the same "no usable link" signal every caller already handles)
  // rather than letting decryptSecret throw — this is the single chokepoint
  // that keeps an unconfigured key from surfacing as a 500 anywhere that
  // reads a Vault token, including every Stage route.
  if (!vaultLinkingEnabled) return null;

  const row = await vaultLinkRow(userId);
  if (!row) return null;

  const SKEW_MS = 30_000;
  if (row.expiresAt.getTime() > Date.now() + SKEW_MS) {
    return decryptSecret(row.accessTokenEnc);
  }

  try {
    const refreshed = await refreshVaultToken(decryptSecret(row.refreshTokenEnc));
    await upsertVaultLink(userId, row.vaultUserId, refreshed);
    return refreshed.access_token;
  } catch (err) {
    console.error(`vault token refresh failed for user ${userId}:`, err instanceof Error ? err.message : err);
    await deleteVaultLink(userId);
    return null;
  }
}
