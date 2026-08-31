# Sign-in freeze

Status: **BUILT** 2026-08-26, migration 017. Server-verified against the
compose stack — see §7. ⚠️ No browser pass yet: the console toggles and the
error copy have not been seen in a real client.

Owner-requested 2026-08-26, off the roadmap. A toggle that stops new sessions
being created — per account, and for everyone at once.

The stated goal: *"completely eliminate the chance for anyone getting in while
things are stable and no new devices are being used."*

## 1. ⚠️ Why this is not "block unknown devices"

The request was phrased as blocking sign-ins from *different devices*. Den
cannot do that, and it is worth being precise about why rather than shipping
something that looks like it does.

**There is no device identity anywhere in Den.** The only per-session signal is
`sessions.user_agent`, and it fails in both directions at once:

- **It does not identify.** A UA string is client-supplied plain text. An
  attacker with a working password copies a stock iPhone UA and is
  indistinguishable from the real phone. The check would be theatre.
- **It is not stable.** A browser update rewrites it. So the people it *would*
  reliably block are your own users, on the ordinary day their phone updated.

A control that blocks legitimate users and admits attackers is worse than no
control, because it is believed. `security_events` already treats
`session.new_device` as a deliberately weak, informational signal
(`admin/events.ts:isUnfamiliarUserAgent` says so in its header); nothing may
*authorize* on it.

**So the freeze refuses to mint sessions at all** — no identification attempted,
nothing to forge. That is strictly stronger than the requested behaviour and it
is exactly the stated goal: while it is on, and everyone who needs access is
already signed in, there is no way in.

## 2. Shape

Two independent switches, both meaning "no new sessions":

| Switch | Where | Scope |
|---|---|---|
| Per-account | `users.logins_frozen_at` | that account |
| Global | `app_settings.signins_frozen_at` | every account |

Either one being set freezes an account. They are deliberately **not** one
field: a global lockdown must not silently clear the per-user freezes you set
during an incident when you lift it.

### What freezing does and does not do

- **Does:** refuse to create a new session — password *and* passkey, even with
  perfectly correct credentials.
- **Does not:** touch existing sessions. That is the whole point. Everyone
  already signed in carries on with nothing to notice.
- **Does not:** disable the account (`users.disabled_at`, docs/ADMIN_CONSOLE.md
  §7). Disabling is "this person is out"; freezing is "the door is bolted for
  now". They are independent and can both be set.

### ⚠️ The cost, stated plainly

A frozen user who loses their session **cannot get back in without the owner**.
Ways that happens: the 30-day rolling session finally expires, they clear site
data, they reinstall the PWA, or — the one that matters here — **iOS evicts PWA
storage**, which PROJECT.md §12 lists as a real and recurring hazard.

This is accepted, not overlooked. It is the direct consequence of the security
property being asked for, and the mitigations are: the error message names a
person to contact (§4), the owner gets alerted when it happens (§5), and the
CLI can lift it without the app (§6).

## 3. Enforcement points

Exactly two, and both check **after** the credential is verified:

- `routes/auth.ts` — the password login path.
- `routes/passkeys.ts` — `/auth/passkey/login/verify`.

⚠️ **After, never before.** Answering "that account is frozen" to an unverified
caller would tell a stranger which usernames exist and which are locked down —
the same reasoning that puts the `disabled_at` check after the verify, and the
same reasoning behind `DUMMY_HASH`. You must first prove the account is yours.

Session *resolution* is untouched: `resolveSession` must keep working, or
freezing would sign everyone out, which is the opposite of the intent.

## 4. The error

New code `signin_frozen` (403). The message is the feature's user-facing half —
someone hitting this is either a locked-out friend or an attacker, and the
friend needs to know what to do:

> Sign-in is paused for this account. Ask {ownerName} to unlock it.

`ownerName` is the display name of an owner, resolved server-side. Falls back
to a generic "the owner" when nobody holds the flag. ⚠️ No email, no link — a
closed friend circle already has a channel, and putting a contact address in an
unauthenticated error response hands it to whoever is trying to get in.

## 5. Telling the owner

Two `security_events` kinds, and the second one is the valuable one:

- `signin.frozen` / `signin.unfrozen` — owner actions, with actor.
- **`signin.blocked`** — a sign-in was refused *after the credentials checked
  out*. This is the alarm worth having: someone had the right password or a
  valid passkey and was stopped. It is either your friend needing help or
  proof that a credential is compromised, and both are things to hear about
  immediately.

`signin.blocked` also sends a push to the owner, throttled to one per account
per hour so a friend retrying in a loop cannot spam the phone.

## 6. Surfaces

- **Admin → People:** per-user toggle, showing whether a freeze is per-user,
  inherited from the global switch, or both.
- **Admin → a global switch**, prominent, with the count of currently-frozen
  accounts under it.
- **CLI:** `npm run auth:freeze status | on <username> | off <username> |
  global-on | global-off`. ⚠️ Load-bearing, not a convenience: if the owner
  freezes sign-ins and then loses their own session, the console is
  unreachable and the shell is the only way back.

Freezing is a **reversible, low-harm** action, so it does NOT sit behind the
re-auth gate (docs/ADMIN_CONSOLE.md §6) — same reasoning as clearing a lock: a
prompt on every flip trains the owner to click through it.

## 7. Verification

`scripts/probe-freeze.ts`, 2026-08-26 — **all 20 checks pass**.

| Area | Checks |
|---|---|
| Per-user freeze | correct password → `403 signin_frozen` · the message names the owner by display name · **no session cookie is issued** |
| **No enumeration** | a **wrong** password on a frozen account still returns `401 invalid_credentials` |
| **Existing sessions** | a session issued before the freeze keeps working throughout |
| Blast radius | a per-user freeze leaves every other account signing in normally |
| Global switch | freezes an account with no flag of its own, **including the owner** · lifting it **preserves** a per-user freeze set independently |
| **Passkeys** | a valid assertion works before the freeze and is refused (`403 signin_frozen`) after |
| Audit | `signin.blocked` recorded, naming the blocked account |

Two of these are the ones worth re-running after any change here.

**The passkey row**, because it is the hole this feature could most plausibly
have had: a passkey proves identity beautifully and says nothing about whether
the door is bolted. If it walked through the freeze, the owner would believe
sign-ins were shut while every enrolled device still had a key — and nothing in
the password path would reveal it. That is why `assertSigninAllowed` is one
shared function called from both paths rather than two inline checks.

**The no-enumeration row**, because the freeze is a per-account state and any
per-account state is a potential oracle. A frozen account must answer a wrong
password exactly as every other account does.

### Two probe bugs worth remembering

Both were in the *test*, not the code, and both would have read as product
failures:

1. The probe tried to enrol a passkey on the account §6 deliberately leaves
   frozen — you cannot register a credential without a session, and you cannot
   get a session while frozen. It reported `signin_frozen` on a step that was
   never meant to be frozen.
2. It sent only the session cookie to `/register/verify`, dropping the signed
   **challenge** cookie that `/options` sets. The ceremony then failed as a
   generic `passkey_failed`, which looks exactly like a broken signature. The
   real client carries both cookies automatically, which is precisely why a
   hand-rolled probe can invent failures the product does not have.

### Not yet verified

- **No browser pass.** The global switch, the per-user toggle in Admin →
  People, and the wording a locked-out person actually sees have not been
  looked at in a real client.
- The **push alert** on `signin.blocked` has not been observed on a device —
  only the event row is asserted.
- Nothing on iOS.
