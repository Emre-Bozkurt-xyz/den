/**
 * At-rest encryption for `vault_links`' OAuth tokens (docs/EMBEDS.md §5.1:
 * "encrypted at rest, server-only, never sent to the client"). AES-256-GCM
 * with a key derived from `env.vaultTokenEncKey` — `createHash('sha256')`
 * turns whatever-length secret is configured into exactly 32 bytes, the same
 * shape `auth/session.ts` gives the session cookie secret.
 *
 * Ciphertext layout: `base64(iv(12) || authTag(16) || ciphertext)` — one
 * opaque string per column, no separate columns needed for iv/tag.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derived lazily and memoized — NOT at module load. `vaultTokenEncKey` is
 * optional (an unset key disables Vault linking rather than killing the app,
 * see env.ts), so deriving at import time would resurrect exactly the
 * boot-crash this indirection exists to prevent: importing anything in this
 * module would throw before the server could even start.
 *
 * Callers must gate on `vaultLinkingEnabled` first; reaching here without a
 * key is a routing bug, so it throws rather than inventing a fallback key.
 */
let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) {
    if (!env.vaultTokenEncKey) {
      throw new Error('VAULT_TOKEN_ENC_KEY is not configured — Vault linking is disabled');
    }
    cachedKey = createHash('sha256').update(env.vaultTokenEncKey).digest();
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64');
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
