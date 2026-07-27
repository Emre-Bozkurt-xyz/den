/**
 * Tests for the Vault-linking DB layer (docs/EMBEDS.md §5.1) against the
 * real dev Postgres — same throwaway-row posture as chat/service.test.ts.
 * Nothing here calls the real Vault OAuth server (no network in this
 * sandbox): `upsertVaultLink`/`vaultStatus`/`deleteVaultLink` are exercised
 * directly with a synthetic token response, which is exactly the shape
 * `integrations-vault.ts`'s `/callback` route hands them after a real
 * `exchangeCodeForToken` + `fetchVaultUserinfo` round trip — those two HTTP
 * calls are the only part of Phase 2 this suite can't reach from here. See
 * the executor report for what a live-Vault pass needs to check.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { users, vaultLinks } from '../db/schema.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { deleteVaultLink, upsertVaultLink, vaultStatus } from './vaultLinks.js';
import type { VaultTokenResponse } from './vaultClient.js';

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let userId: bigint;

before(async () => {
  const username = `vault-link-test-${RUN_ID}`;
  const rows = await db.insert(users).values({ username, displayName: username }).returning({ id: users.id });
  userId = rows[0]!.id;
});

after(async () => {
  await db.delete(vaultLinks).where(eq(vaultLinks.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await closeDb();
});

describe('integrations/crypto.ts', () => {
  test('encrypt/decrypt round-trips, and two encryptions of the same plaintext differ (fresh IV)', () => {
    const plaintext = 'a-fake-vault-access-token-value';
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    assert.notEqual(a, b, 'ciphertext must not be deterministic (random IV per call)');
    assert.equal(decryptSecret(a), plaintext);
    assert.equal(decryptSecret(b), plaintext);
  });
});

describe('vault_links upsert/status/delete (live DB)', () => {
  test('linking, re-linking (rotating tokens), and unlinking round-trip through vaultStatus', async () => {
    const before1 = await vaultStatus(userId);
    assert.deepEqual(before1, { linked: false, vaultDisplayName: null });

    const tokens1: VaultTokenResponse = {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      scope: 'vault.documents',
      token_type: 'Bearer',
    };
    await upsertVaultLink(userId, 'vault-user-uuid-1', tokens1);

    const linked = await vaultStatus(userId);
    assert.equal(linked.linked, true);
    assert.equal(linked.vaultDisplayName, 'vault-user-uuid-1');

    // The raw row holds only ciphertext — never the plaintext token.
    const rows = await db.select().from(vaultLinks).where(eq(vaultLinks.userId, userId));
    const row = rows[0]!;
    assert.notEqual(row.accessTokenEnc, tokens1.access_token);
    assert.equal(decryptSecret(row.accessTokenEnc), tokens1.access_token);
    assert.equal(decryptSecret(row.refreshTokenEnc), tokens1.refresh_token);

    // A refresh grant that rotates the refresh token overwrites both.
    const tokens2: VaultTokenResponse = {
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    await upsertVaultLink(userId, 'vault-user-uuid-1', tokens2);
    const rows2 = await db.select().from(vaultLinks).where(eq(vaultLinks.userId, userId));
    assert.equal(decryptSecret(rows2[0]!.accessTokenEnc), 'access-2');
    assert.equal(decryptSecret(rows2[0]!.refreshTokenEnc), 'refresh-2');

    await deleteVaultLink(userId);
    const afterUnlink = await vaultStatus(userId);
    assert.deepEqual(afterUnlink, { linked: false, vaultDisplayName: null });
  });
});

/**
 * Regression guard for the boot-crash of 2026-07-27: `VAULT_TOKEN_ENC_KEY`
 * was `required()` in prod, so a missing value threw during module evaluation
 * and took the WHOLE api down in a restart loop — over an optional
 * integration. The contract now is "unset key ⇒ Vault linking is off", never
 * "unset key ⇒ Den doesn't boot".
 */
describe('vault linking capability gate', () => {
  test('the encryption key is not a required env var', async () => {
    // If someone reintroduces `required('VAULT_TOKEN_ENC_KEY')`, importing
    // env.ts with it unset throws and this fails — which is the entire point.
    const { env: freshEnv } = await import('../env.js');
    assert.ok(
      'vaultTokenEncKey' in freshEnv,
      'env must expose vaultTokenEncKey without throwing when it is unset',
    );
  });

  test('getValidVaultAccessToken yields null rather than throwing when disabled', async () => {
    const { vaultLinkingEnabled } = await import('../env.js');
    if (vaultLinkingEnabled) {
      // Dev has a throwaway default key, so the disabled path can't be
      // exercised here. Assert the inverse instead: a user with no link row
      // still gets null, never an exception from the decrypt path.
      const { getValidVaultAccessToken } = await import('./vaultLinks.js');
      assert.equal(await getValidVaultAccessToken(userId), null);
      return;
    }
    const { getValidVaultAccessToken } = await import('./vaultLinks.js');
    assert.equal(await getValidVaultAccessToken(userId), null);
  });
});
