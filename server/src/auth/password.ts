/**
 * Password hashing — argon2id (BACKBONE §10, hard invariant 9).
 *
 * MVP auth is invite + password. When passkeys/OAuth land (post-MVP), these
 * accounts keep their password as one of several login methods; the
 * "≥1 login method" rule counts them all (§5). This module never changes.
 */
import { hash, verify } from '@node-rs/argon2';

// OWASP-ish params. @node-rs/argon2 defaults algorithm to Argon2id (we avoid
// importing the Algorithm const enum — it clashes with verbatimModuleSyntax).
const OPTS = {
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    // Malformed hash or verify error — treat as non-match, never throw to caller.
    return false;
  }
}
