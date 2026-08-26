/**
 * Owner privilege CLI (docs/ADMIN_CONSOLE.md §4).
 *
 * ⚠️ **This is the ONLY way `is_owner` is ever set.** There is deliberately no
 * API route and no in-app toggle — not even for an existing owner — so that an
 * attacker holding a fully compromised session still cannot escalate to admin.
 * Privilege is conferred from the host shell, by someone with access to the
 * server itself. Do not add a route that does this.
 *
 * Follows the `invite.ts` pattern exactly.
 *
 * Usage (from repo root):
 *   npm run owner list
 *   npm run owner grant <username>
 *   npm run owner revoke <username>
 *
 * Dev shortcut (no build): npx tsx server/src/scripts/owner.ts list
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { users } from '../db/schema.js';

async function list(): Promise<void> {
  const rows = await db
    .select({ id: users.id, username: users.username, isOwner: users.isOwner })
    .from(users)
    .orderBy(users.username);

  const owners = rows.filter((r) => r.isOwner);
  if (owners.length === 0) {
    console.log('No owners. Grant one with:  npm run owner grant <username>');
  } else {
    console.log('Owners:');
    for (const o of owners) console.log(`  ${o.username}  (id ${o.id})`);
  }
  const others = rows.filter((r) => !r.isOwner);
  if (others.length > 0) {
    console.log(`\nOther accounts: ${others.map((o) => o.username).join(', ')}`);
  }
}

async function setOwner(username: string, value: boolean): Promise<void> {
  const name = username.trim().toLowerCase();
  const updated = await db
    .update(users)
    .set({ isOwner: value })
    .where(eq(users.username, name))
    .returning({ id: users.id, username: users.username });

  if (updated.length === 0) {
    console.error(`No such user: "${name}"`);
    process.exitCode = 1;
    return;
  }
  const u = updated[0]!;
  console.log(
    value
      ? `"${u.username}" is now an owner. The Admin section appears in Settings on their next /me fetch (reload the app).`
      : `"${u.username}" is no longer an owner.`,
  );

  if (!value) {
    // Revoking the last owner locks the console for everyone, and the only way
    // back is this same CLI. Worth saying out loud rather than discovering.
    const remaining = await db.select({ id: users.id }).from(users).where(eq(users.isOwner, true));
    if (remaining.length === 0) {
      console.log('\n⚠️  There are now NO owners. The admin console is unreachable until you');
      console.log('   grant one again from this shell.');
    }
  }
}

async function main(): Promise<void> {
  const [cmd, username] = process.argv.slice(2);
  try {
    if (cmd === 'list') {
      await list();
    } else if (cmd === 'grant' && username) {
      await setOwner(username, true);
    } else if (cmd === 'revoke' && username) {
      await setOwner(username, false);
    } else {
      console.log('Usage: owner <list | grant <username> | revoke <username>>');
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}

void main();
