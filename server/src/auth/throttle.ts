/**
 * Per-account login throttle (docs/AUTH_HARDENING.md §2.2).
 *
 * The bound that matters is keyed on the SUBMITTED USERNAME, not the client
 * address, for a measured reason: the real client IP does not survive Den's
 * proxy chain (auth/clientIp.ts), so an IP-keyed limit protects nothing today
 * — and even with the chain fixed, rotating addresses is cheap for an attacker
 * while rotating the username they are trying to break into is not.
 *
 * ⚠️ Rows are recorded for usernames that DO NOT EXIST, and a nonexistent
 * username locks exactly like a real one. That is load-bearing: a throttle
 * that only engaged for real accounts would answer "does this user exist?"
 * from outside, which would undo the constant-time DUMMY_HASH verify in
 * routes/auth.ts. Never add a "skip if no such user" fast path here.
 *
 * ⚠️ Known, accepted tradeoff: because the lock is checked BEFORE the password
 * is verified, someone who knows a username can lock its owner out by spamming
 * wrong passwords. Admitting a correct password during a lock would remove the
 * DoS but also remove the guess-rate bound — it would become an alarm, not a
 * limit. The lock is instead made survivable: it caps at 15 minutes, it pushes
 * the owner an alert, and `npm run auth:unlock <username>` clears it. See the
 * plan doc for the full argument before changing this.
 */
import { and, count, desc, eq, gte, lt } from 'drizzle-orm';
import { LoginThrottle } from '@den/shared';
import { db } from '../db/index.js';
import { loginFailures } from '../db/schema.js';

export interface LockState {
  locked: boolean;
  /** Failures inside the window (including the ones that caused the lock). */
  failures: number;
  /** When the lock lifts. Null when not locked. */
  until: Date | null;
  /** Whole seconds until the lock lifts, floored at 1. Zero when not locked. */
  retryAfterSeconds: number;
}

const NOT_LOCKED: LockState = { locked: false, failures: 0, until: null, retryAfterSeconds: 0 };

/**
 * Lock duration for `failures` total failures: doubles from `baseLockMs` for
 * each failure past the threshold, capped at `maxLockMs`. 10 fails → 1 min,
 * 11 → 2 min, 12 → 4 min, … 14+ → 15 min.
 */
export function lockDurationMs(failures: number): number {
  const over = Math.max(0, failures - LoginThrottle.threshold);
  // Cap the exponent before shifting — 2 ** big is Infinity, and Infinity
  // through Math.min is fine, but a huge intermediate is needless.
  const factor = 2 ** Math.min(over, 20);
  return Math.min(LoginThrottle.baseLockMs * factor, LoginThrottle.maxLockMs);
}

/**
 * Is this username currently locked? Reads only — call before verifying the
 * password so a locked account never pays the argon2 cost.
 */
export async function checkLock(username: string, now = new Date()): Promise<LockState> {
  const windowStart = new Date(now.getTime() - LoginThrottle.windowMs);

  const rows = await db
    .select({ createdAt: loginFailures.createdAt })
    .from(loginFailures)
    .where(and(eq(loginFailures.username, username), gte(loginFailures.createdAt, windowStart)))
    .orderBy(desc(loginFailures.createdAt))
    .limit(LoginThrottle.threshold * 4);

  const failures = rows.length;
  if (failures < LoginThrottle.threshold) return { ...NOT_LOCKED, failures };

  const lastFailure = rows[0]!.createdAt;
  const until = new Date(lastFailure.getTime() + lockDurationMs(failures));
  if (until.getTime() <= now.getTime()) {
    // The lock elapsed but the failures are still inside the counting window.
    // Not locked — the next failure will re-lock, for longer.
    return { locked: false, failures, until: null, retryAfterSeconds: 0 };
  }
  return {
    locked: true,
    failures,
    until,
    retryAfterSeconds: Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
  };
}

/** Record one failed attempt. Returns the lock state it produces. */
export async function recordFailure(
  username: string,
  ip: string | null,
  userAgent: string | null,
): Promise<LockState> {
  await db.insert(loginFailures).values({ username, ip, userAgent: userAgent ?? null });
  return checkLock(username);
}

/**
 * Clear an account's failures. Called on every successful login — a user who
 * can prove who they are resets their own counter — and by the unlock CLI.
 * Returns how many rows were cleared.
 */
export async function clearFailures(username: string): Promise<number> {
  const deleted = await db
    .delete(loginFailures)
    .where(eq(loginFailures.username, username))
    .returning({ id: loginFailures.id });
  return deleted.length;
}

/**
 * Drop rows that can no longer affect any decision. Cheap and opportunistic —
 * called on the failure path rather than from a scheduler, because Den has no
 * background job runner and this table only grows when someone is failing to
 * log in. Never throws into the request path.
 */
export async function sweepExpired(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - LoginThrottle.windowMs - LoginThrottle.maxLockMs);
  try {
    await db.delete(loginFailures).where(lt(loginFailures.createdAt, cutoff));
  } catch (e) {
    console.error('login_failures sweep failed:', e instanceof Error ? e.message : e);
  }
}

/** Failure count inside the window, for the CLI's status output. */
export async function failureCount(username: string, now = new Date()): Promise<number> {
  const windowStart = new Date(now.getTime() - LoginThrottle.windowMs);
  const rows = await db
    .select({ n: count() })
    .from(loginFailures)
    .where(and(eq(loginFailures.username, username), gte(loginFailures.createdAt, windowStart)));
  return Number(rows[0]?.n ?? 0);
}
