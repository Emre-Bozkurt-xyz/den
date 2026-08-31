/**
 * Sign-in freeze (docs/SIGNIN_FREEZE.md).
 *
 * While frozen, no NEW session may be created for an account — by password or
 * by passkey, even with perfectly correct credentials. Existing sessions are
 * untouched, which is the entire point: the door is bolted, nobody already
 * inside is disturbed.
 *
 * ⚠️ This is deliberately NOT "block unknown devices", which is what was
 * originally asked for. Den has no device identity; the only signal is
 * `sessions.user_agent`, which an attacker copies from any phone and which a
 * browser update rewrites. Such a check would admit attackers and block real
 * users — worse than nothing, because it would be believed. Refusing to mint
 * sessions at all identifies nothing and so can be forged by nobody.
 *
 * ⚠️ `resolveSession` must NEVER consult this. Freezing means "no new way in",
 * not "sign everyone out"; wiring it into session resolution would invert the
 * feature.
 */
import { eq, sql } from 'drizzle-orm';
import { ErrorCode } from '@den/shared';
import { db } from '../db/index.js';
import { appSettings, users } from '../db/schema.js';
import { AppError } from '../errors.js';

/** The singleton settings row's id — there is exactly one, seeded by 017. */
export const APP_SETTINGS_ID = 1;

export interface FreezeState {
  /** This account's own flag. */
  perUser: Date | null;
  /** The server-wide switch. */
  global: Date | null;
}

/** Either switch being set means frozen. */
export function isFrozen(state: FreezeState): boolean {
  return state.perUser !== null || state.global !== null;
}

export async function globalFreeze(): Promise<Date | null> {
  const rows = await db
    .select({ at: appSettings.signinsFrozenAt })
    .from(appSettings)
    .where(eq(appSettings.id, APP_SETTINGS_ID))
    .limit(1);
  return rows[0]?.at ?? null;
}

/** Both switches for one account, in a single round trip. */
export async function freezeStateFor(userId: bigint): Promise<FreezeState> {
  const rows = await db
    .select({
      perUser: users.loginsFrozenAt,
      global: sql<Date | null>`(select signins_frozen_at from app_settings where id = ${APP_SETTINGS_ID})`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  return {
    perUser: row?.perUser ?? null,
    global: row?.global ? new Date(row.global) : null,
  };
}

/**
 * Who should a locked-out person contact?
 *
 * ⚠️ A display name, never an email or a link. This message is returned to an
 * UNAUTHENTICATED caller who might be the attacker, and a contact address in
 * that response is a contact address handed to them. A closed friend circle
 * already knows how to reach its owner by name.
 */
export async function ownerDisplayName(): Promise<string> {
  try {
    const rows = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.isOwner, true))
      .limit(1);
    return rows[0]?.displayName ?? 'the owner';
  } catch {
    return 'the owner';
  }
}

/** The error a frozen sign-in returns. 403: allowed in principle, refused now. */
export async function signinFrozenError(): Promise<AppError> {
  const owner = await ownerDisplayName();
  return new AppError(
    403,
    ErrorCode.SigninFrozen,
    `Sign-in is paused for this account. Ask ${owner} to unlock it.`,
  );
}

// ─── owner controls ─────────────────────────────────────────────────────────

export async function setUserFreeze(userId: bigint, frozen: boolean): Promise<string | null> {
  const updated = await db
    .update(users)
    .set({ loginsFrozenAt: frozen ? new Date() : null })
    .where(eq(users.id, userId))
    .returning({ username: users.username });
  return updated[0]?.username ?? null;
}

export async function setGlobalFreeze(frozen: boolean, actorUserId: bigint | null): Promise<void> {
  await db
    .update(appSettings)
    .set({
      signinsFrozenAt: frozen ? new Date() : null,
      updatedBy: actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(appSettings.id, APP_SETTINGS_ID));
}

/** Usernames with their own freeze flag set — for the CLI and the console. */
export async function frozenUsernames(): Promise<string[]> {
  const rows = await db
    .select({ username: users.username })
    .from(users)
    .where(sql`${users.loginsFrozenAt} is not null`)
    .orderBy(users.username);
  return rows.map((r) => r.username);
}
