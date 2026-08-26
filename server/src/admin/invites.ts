/**
 * Invite minting, shared by the CLI and the console (docs/ADMIN_CONSOLE.md §3c).
 *
 * Extracted from `scripts/invite.ts` so both callers produce identical codes —
 * two generators drifting apart would be the kind of bug nobody notices until
 * a code from one path fails to validate on the other.
 */
import { randomBytes } from 'node:crypto';

/** Human-friendlyish code: 4 groups of 4, no I/O/0/1 to survive being read
 *  aloud or copied off a screen. ~80 bits. */
export function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i !== 15) out += '-';
  }
  return out;
}

export function generateInviteCodes(n: number): string[] {
  return Array.from({ length: n }, generateInviteCode);
}
