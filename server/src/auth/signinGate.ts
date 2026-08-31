/**
 * The one place a sign-in is allowed or refused after credentials check out
 * (docs/SIGNIN_FREEZE.md §3).
 *
 * Extracted rather than inlined twice because the password path and the passkey
 * path must agree exactly. A freeze that a passkey could walk through would be
 * worse than no freeze: the owner would believe the door was bolted while every
 * enrolled device still had a key.
 */
import { SecurityEventKind, record } from '../admin/events.js';
import { notifyUser } from '../push/notify.js';
import { freezeStateFor, isFrozen, signinFrozenError } from './freeze.js';

/**
 * One alert per account per hour. A locked-out friend retrying in a loop
 * must not be able to empty the owner's battery — and after the first one,
 * every further attempt tells the owner nothing new.
 */
const ALERT_INTERVAL_MS = 60 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

/**
 * Throws when this account may not start a new session right now.
 *
 * ⚠️ Call only AFTER the credential has been verified. Calling it earlier would
 * turn the freeze into an account-existence oracle, undoing the constant-time
 * work in routes/auth.ts.
 */
export async function assertSigninAllowed(
  userId: bigint,
  username: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  const state = await freezeStateFor(userId);
  if (!isFrozen(state)) return;

  // Durable record first — this is the alarm the feature exists to raise
  // (§5): the credentials were RIGHT and we said no anyway.
  void record({
    kind: SecurityEventKind.SigninBlocked,
    userId,
    username,
    ip,
    userAgent,
    data: {
      scope: state.perUser && state.global ? 'both' : state.perUser ? 'user' : 'global',
    },
  });

  const key = userId.toString();
  const last = lastAlertAt.get(key) ?? 0;
  if (Date.now() - last >= ALERT_INTERVAL_MS) {
    lastAlertAt.set(key, Date.now());
    void notifyUser(userId, {
      title: 'Den · sign-in blocked',
      body: `Someone signed in correctly as ${username}, but sign-in is frozen for that account. If that was them, unfreeze it — if not, their credentials are compromised.`,
      topic: 'auth-alert',
    });
  }

  throw await signinFrozenError();
}
