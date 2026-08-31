/**
 * Sign-in freeze CLI (docs/SIGNIN_FREEZE.md §6).
 *
 * ⚠️ **Load-bearing, not a convenience.** Freezing sign-ins and then losing
 * your own session — an expired cookie, cleared site data, iOS evicting PWA
 * storage — leaves the admin console unreachable, because reaching it requires
 * signing in and signing in is what you just froze. This shell is the way back.
 * Keep it working, and keep it runnable inside the api container.
 *
 * Usage (from repo root, or inside the container):
 *   npm run auth:freeze status
 *   npm run auth:freeze on <username>      | off <username>
 *   npm run auth:freeze global-on          | global-off
 */
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { frozenUsernames, globalFreeze, setGlobalFreeze, setUserFreeze } from '../auth/freeze.js';

async function status(): Promise<void> {
  const [global, frozen] = await Promise.all([globalFreeze(), frozenUsernames()]);

  console.log(`Global sign-in freeze: ${global ? `ON since ${global.toISOString()}` : 'off'}`);
  if (global) {
    console.log('  ⚠️  EVERY account is frozen, whatever its own flag says.');
  }
  console.log(
    frozen.length > 0
      ? `\nIndividually frozen: ${frozen.join(', ')}`
      : '\nNo individually frozen accounts.',
  );
  console.log('\nFrozen accounts keep their EXISTING sessions — this only stops new sign-ins.');
}

async function setUser(username: string, frozen: boolean): Promise<void> {
  const name = username.trim().toLowerCase();
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1);
  const id = rows[0]?.id;
  if (id === undefined) {
    console.error(`No such user: "${name}"`);
    process.exitCode = 1;
    return;
  }
  await setUserFreeze(id, frozen);
  console.log(
    frozen
      ? `Sign-in frozen for "${name}". Existing sessions keep working; no new ones can be created.`
      : `Sign-in unfrozen for "${name}".`,
  );
  if (!frozen && (await globalFreeze())) {
    // Easy to miss and confusing: the per-user flag is off but nothing changed.
    console.log('⚠️  The GLOBAL freeze is still on, so this account remains frozen.');
  }
}

async function setGlobal(frozen: boolean): Promise<void> {
  await setGlobalFreeze(frozen, null);
  console.log(frozen ? 'Global sign-in freeze is ON — no account can start a new session.' : 'Global sign-in freeze is OFF.');
  if (!frozen) {
    const still = await frozenUsernames();
    if (still.length > 0) {
      // Deliberate: lifting the global switch must not clear per-user freezes
      // set during the same incident (§2). Say so rather than let it surprise.
      console.log(`⚠️  Still individually frozen: ${still.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const [cmd, username] = process.argv.slice(2);
  try {
    if (cmd === 'status') await status();
    else if (cmd === 'on' && username) await setUser(username, true);
    else if (cmd === 'off' && username) await setUser(username, false);
    else if (cmd === 'global-on') await setGlobal(true);
    else if (cmd === 'global-off') await setGlobal(false);
    else {
      console.log('Usage: auth:freeze <status | on <username> | off <username> | global-on | global-off>');
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}

void main();
