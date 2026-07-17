/**
 * Friendship helpers (BACKBONE §5). `friendships` stores one row per unordered
 * pair with the invariant user_a < user_b — `pair()` keeps every caller
 * consistent with that ordering.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { friendships } from '../db/schema.js';

export function pair(a: bigint, b: bigint): [bigint, bigint] {
  return a < b ? [a, b] : [b, a];
}

/** True only for accepted (mutual) friendships — pending doesn't count. */
export async function areFriends(a: bigint, b: bigint): Promise<boolean> {
  const [userA, userB] = pair(a, b);
  const rows = await db
    .select({ status: friendships.status })
    .from(friendships)
    .where(and(eq(friendships.userA, userA), eq(friendships.userB, userB)))
    .limit(1);
  return rows[0]?.status === 'accepted';
}
