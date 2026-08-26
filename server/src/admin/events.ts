/**
 * Security event recording (docs/ADMIN_CONSOLE.md §5).
 *
 * One append-only table is the substrate for the whole console; every view is
 * a query over it. Existing security paths write here as well as doing their
 * own job, which is why the feed has history from the day the console ships
 * rather than starting empty.
 *
 * ⚠️ `record()` NEVER throws. Callers are on the login path, the passkey path
 * and the invite path — none of them may fail because an audit write failed.
 * A dropped event is bad; a login that 500s because we could not write a log
 * line is worse.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { securityEvents, users } from '../db/schema.js';

/**
 * The closed set of event kinds. Kept as a const object rather than free
 * strings so a typo becomes a compile error instead of an event that silently
 * never matches a filter.
 */
export const SecurityEventKind = {
  /** An account crossed the failure threshold and was locked. */
  LoginLocked: 'login.locked',
  /** A session was created from a user-agent this account hadn't used before. */
  SessionNewDevice: 'session.new_device',
  /** A passkey was registered. */
  CredentialAdded: 'credential.added',
  /** A passkey was removed. */
  CredentialRemoved: 'credential.removed',
  /** An invite code was claimed, creating an account. */
  InviteClaimed: 'invite.claimed',
  /** Owner action: a lock was cleared by hand. */
  LockCleared: 'lock.cleared',
  /** Owner action: an unused invite was revoked. */
  InviteRevoked: 'invite.revoked',
  /** Owner action: a session was revoked. */
  SessionRevoked: 'session.revoked',
  /** Owner action: an account was disabled / re-enabled. */
  UserDisabled: 'user.disabled',
  UserEnabled: 'user.enabled',
} as const;

export type SecurityEventKindName = (typeof SecurityEventKind)[keyof typeof SecurityEventKind];

export interface RecordEventInput {
  kind: SecurityEventKindName;
  /** The account this is ABOUT. Omit when no such user exists. */
  userId?: bigint | null;
  /** The username as submitted/known. Kept even when `userId` is null. */
  username?: string | null;
  /** Who did it, for owner actions. Omit for system-generated events. */
  actorUserId?: bigint | null;
  ip?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
}

/** Append one event. Never throws — see the module header. */
export async function record(input: RecordEventInput): Promise<void> {
  try {
    await db.insert(securityEvents).values({
      kind: input.kind,
      userId: input.userId ?? null,
      username: input.username ?? null,
      actorUserId: input.actorUserId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      data: input.data ?? {},
    });
  } catch (e) {
    console.error('security event write failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Has this account been seen on this user-agent before?
 *
 * ⚠️ A deliberately weak signal, and named honestly rather than as "new device".
 * A user-agent is not a device: two phones of the same model report the same
 * string, and a browser update changes it. It is what `sessions` already stores
 * (there is no device identity in Den), so it is what we can ask. It exists to
 * make an unfamiliar sign-in *visible*, not to authorize anything — nothing
 * branches on the answer except whether to write an event.
 */
export async function isUnfamiliarUserAgent(
  userId: bigint,
  userAgent: string | null | undefined,
): Promise<boolean> {
  if (!userAgent) return false; // no information — don't manufacture an alert
  try {
    const seen = await db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.userId, userId),
          eq(securityEvents.kind, SecurityEventKind.SessionNewDevice),
          eq(securityEvents.userAgent, userAgent),
        ),
      )
      .limit(1);
    return seen.length === 0;
  } catch {
    return false;
  }
}

export interface EventRow {
  id: bigint;
  kind: string;
  userId: bigint | null;
  username: string | null;
  actorUserId: bigint | null;
  actorUsername: string | null;
  ip: string | null;
  userAgent: string | null;
  data: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Keyset page of the feed, newest first (`before` = an id, per the repo's
 * pagination convention — no OFFSET in new code).
 */
export async function listEvents(opts: {
  before?: bigint;
  kind?: string;
  userId?: bigint;
  limit: number;
}): Promise<EventRow[]> {
  const actor = db.$with('actor').as(db.select({ id: users.id, username: users.username }).from(users));
  const filters = [
    opts.before !== undefined ? lt(securityEvents.id, opts.before) : undefined,
    opts.kind ? eq(securityEvents.kind, opts.kind) : undefined,
    opts.userId !== undefined ? eq(securityEvents.userId, opts.userId) : undefined,
  ].filter(Boolean);

  return db
    .with(actor)
    .select({
      id: securityEvents.id,
      kind: securityEvents.kind,
      userId: securityEvents.userId,
      username: securityEvents.username,
      actorUserId: securityEvents.actorUserId,
      actorUsername: sql<string | null>`${actor.username}`,
      ip: securityEvents.ip,
      userAgent: securityEvents.userAgent,
      data: securityEvents.data,
      createdAt: securityEvents.createdAt,
    })
    .from(securityEvents)
    .leftJoin(actor, eq(actor.id, securityEvents.actorUserId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(securityEvents.id))
    .limit(opts.limit);
}
