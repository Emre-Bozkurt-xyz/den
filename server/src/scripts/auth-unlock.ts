/**
 * Login-throttle admin CLI (docs/AUTH_HARDENING.md §2.2).
 *
 * The escape hatch that makes the per-account lock an acceptable design. The
 * lock is deliberately checked before the password is verified, which means
 * someone who knows a username can lock its owner out by spamming wrong
 * guesses. That is survivable precisely because the lock is short, the owner
 * is notified, and this command clears it in one step.
 *
 * Usage (from repo root):
 *   node --env-file=.env server/dist/scripts/auth-unlock.js status            # everyone with live failures
 *   node --env-file=.env server/dist/scripts/auth-unlock.js status <username>
 *   node --env-file=.env server/dist/scripts/auth-unlock.js clear <username>
 *
 * Dev shortcut (no build): npx tsx server/src/scripts/auth-unlock.ts status
 */
import { desc, gte, sql } from 'drizzle-orm';
import { LoginThrottle } from '@den/shared';
import { db, closeDb } from '../db/index.js';
import { loginFailures } from '../db/schema.js';
import { checkLock, clearFailures, failureCount } from '../auth/throttle.js';

async function statusAll(): Promise<void> {
  const windowStart = new Date(Date.now() - LoginThrottle.windowMs);
  const rows = await db
    .select({
      username: loginFailures.username,
      n: sql<number>`count(*)::int`,
      last: sql<Date>`max(${loginFailures.createdAt})`,
    })
    .from(loginFailures)
    .where(gte(loginFailures.createdAt, windowStart))
    .groupBy(loginFailures.username)
    .orderBy(desc(sql`count(*)`));

  if (rows.length === 0) {
    console.log(`No failed logins in the last ${Math.round(LoginThrottle.windowMs / 60000)} minutes.`);
    return;
  }
  console.log(`Failed logins in the last ${Math.round(LoginThrottle.windowMs / 60000)} minutes:\n`);
  for (const r of rows) {
    const lock = await checkLock(r.username);
    const state = lock.locked ? `LOCKED for ${lock.retryAfterSeconds}s` : 'not locked';
    console.log(`  ${r.username.padEnd(24)} ${String(r.n).padStart(3)} failures   ${state}`);
  }
  console.log(`\nThreshold is ${LoginThrottle.threshold}. Clear one with: auth-unlock clear <username>`);
}

async function statusOne(username: string): Promise<void> {
  const [n, lock] = await Promise.all([failureCount(username), checkLock(username)]);
  console.log(`  username : ${username}`);
  console.log(`  failures : ${n} (window ${Math.round(LoginThrottle.windowMs / 60000)}m, threshold ${LoginThrottle.threshold})`);
  console.log(`  locked   : ${lock.locked ? `yes, ${lock.retryAfterSeconds}s remaining (until ${lock.until?.toISOString()})` : 'no'}`);

  // Recent attempts, so "was this an attack or my own typo?" is answerable.
  const recent = await db
    .select({ ip: loginFailures.ip, userAgent: loginFailures.userAgent, createdAt: loginFailures.createdAt })
    .from(loginFailures)
    .where(gte(loginFailures.createdAt, new Date(Date.now() - LoginThrottle.windowMs)))
    .orderBy(desc(loginFailures.createdAt))
    .limit(10);
  const mine = recent.filter(() => true);
  if (mine.length > 0) {
    console.log('\n  recent failures (all accounts, newest first):');
    for (const r of mine) {
      console.log(`    ${r.createdAt.toISOString()}  ip=${r.ip ?? '-'}  ua=${(r.userAgent ?? '-').slice(0, 60)}`);
    }
  }
}

async function main(): Promise<void> {
  const [cmd, username] = process.argv.slice(2);
  try {
    if (cmd === 'status' && !username) {
      await statusAll();
    } else if (cmd === 'status' && username) {
      await statusOne(username.trim().toLowerCase());
    } else if (cmd === 'clear' && username) {
      const name = username.trim().toLowerCase();
      const cleared = await clearFailures(name);
      console.log(cleared > 0 ? `Cleared ${cleared} failure row(s) for "${name}" — sign-in is open again.` : `No failures recorded for "${name}".`);
    } else {
      console.log('Usage: auth-unlock <status [username] | clear <username>>');
      process.exitCode = 1;
    }
  } finally {
    await closeDb();
  }
}

void main();
