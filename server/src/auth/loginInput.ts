/**
 * Shape check for `/auth/login` input, run BEFORE anything else touches it.
 *
 * ⚠️ Login is unauthenticated, and it used to pass the submitted username —
 * unbounded — into the lock check, into `recordFailure` (a stored
 * `login_failures` row) and into the log line, and the password — unbounded —
 * into argon2. So a stranger could write arbitrarily large rows and spend
 * server CPU per request with one curl loop.
 *
 * Anything that fails here is refused with the SAME generic invalid-
 * credentials answer as a wrong password, and records no failure row. That
 * leaks nothing: registration enforces exactly these rules (routes/auth.ts
 * `normUsername`/`checkPassword`), so no account can exist whose username or
 * password fails them — "malformed" says nothing about any real account.
 *
 * Deliberately NOT enforced: the password MINIMUM. Raising the floor later
 * must not lock out an account created under an older one; verification is
 * what rejects a short wrong password.
 */
import { AuthLimits } from '@den/shared';

const USERNAME_RE = new RegExp(AuthLimits.usernamePattern);

/** `username` is the already trimmed + lowercased value. */
export function loginInputPlausible(username: string, password: string): boolean {
  if (username.length < AuthLimits.usernameMin || username.length > AuthLimits.usernameMax) return false;
  if (!USERNAME_RE.test(username)) return false;
  if (password.length > AuthLimits.passwordMax) return false;
  return true;
}
