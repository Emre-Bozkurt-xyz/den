/**
 * PKCE (RFC 7636, S256) + OAuth `state` generation for the Vault outbound
 * client flow (docs/EMBEDS.md §5.2). Nothing Vault-specific here — plain
 * crypto helpers.
 */
import { createHash, randomBytes } from 'node:crypto';

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generateState(): string {
  return randomBytes(16).toString('base64url');
}
