/**
 * Invite-code admin CLI (BACKBONE §6, §10). Invites are single-use and are the
 * ENTIRE spam/abuse story for MVP — the trust boundary is at the door.
 *
 * Usage (from repo root):
 *   node --env-file=.env server/dist/scripts/invite.js create [n]   # mint n codes (default 1)
 *   node --env-file=.env server/dist/scripts/invite.js list          # show unused codes
 *   node --env-file=.env server/dist/scripts/invite.js list --all    # include used
 *
 * Dev shortcut (no build): npx tsx server/src/scripts/invite.ts create
 *
 * The first invite has no creator (created_by NULL) — that's how the first user
 * bootstraps the circle.
 */
import { randomBytes } from 'node:crypto';
import { desc, isNull } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { inviteCodes } from '../db/schema.js';

/** Human-friendlyish code: 4 groups of 4 base32-ish chars. */
function genCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i !== 15) out += '-';
  }
  return out;
}

async function create(n: number): Promise<void> {
  const codes = Array.from({ length: n }, genCode);
  await db.insert(inviteCodes).values(codes.map((code) => ({ code })));
  console.log(`Minted ${n} invite code(s):`);
  for (const c of codes) console.log('  ' + c);
}

async function list(all: boolean): Promise<void> {
  const rows = await db
    .select()
    .from(inviteCodes)
    .where(all ? undefined : isNull(inviteCodes.usedBy))
    .orderBy(desc(inviteCodes.createdAt));
  if (rows.length === 0) {
    console.log(all ? 'No invite codes.' : 'No unused invite codes.');
    return;
  }
  for (const r of rows) {
    const status = r.usedBy ? `used by user ${r.usedBy}` : 'UNUSED';
    console.log(`  ${r.code}  —  ${status}`);
  }
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'create') {
      const n = Math.max(1, Math.min(50, Number(arg) || 1));
      await create(n);
    } else if (cmd === 'list') {
      await list(process.argv.includes('--all'));
    } else {
      console.log('Usage: invite <create [n] | list [--all]>');
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}

void main();
