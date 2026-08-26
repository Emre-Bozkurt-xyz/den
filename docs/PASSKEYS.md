# Passkeys (WebAuthn) — plan

Status: **BUILT** 2026-08-26 (roadmap item #1). Server-verified end to end
against the compose stack — see §11. Both decisions settled by the owner the
same day: `@simplewebauthn/*` approved, and the recovery model is **Option A**
(passwords stay as the permanent fallback, no per-user retirement). The domain
was confirmed final, which is what unblocked the rpID commitment in §2.

⚠️ **Awaiting the real-device iOS gate (§10).** Every check in §11 ran against
a software authenticator; nothing here has touched an actual iPhone, and the
installed-PWA ceremony is the highest-risk unknown in the feature.

Prerequisite already met: the per-account login throttle shipped 2026-08-26
(`docs/AUTH_HARDENING.md`). Passkeys and that throttle are designed to fit
together, and §7 is the part worth reading twice — passkeys are what finally
retire the lockout tradeoff that work had to accept.

## 1. What this buys, and what it doesn't

The server stores a **public key**. There is no shared secret, so there is
nothing to guess, nothing to phish, nothing to leak in a dump, and nothing a
proxy chain can mishandle. The entire class of attack the Tier 0 work had to
bound — someone on the internet trying passwords against a known username —
stops existing for accounts that use one.

It does **not** replace the invite system. Invites *authorize* (who may have an
account); passkeys *authenticate* (that you are that account). That split is a
locked assumption in `server/src/routes/auth.ts:4-13` and nothing here changes
it: a passkey can never create an account, only prove one.

## 2. ⚠️ The rpID trap — read before writing a line of code

A passkey binds permanently to a **Relying Party ID**: the domain. Ours is
`den.ems-place.com` (`PUBLIC_ORIGIN`). Once the first real passkey exists:

- Moving Den to another domain **invalidates every passkey ever registered**,
  for everyone, with no migration path. Users would have to re-enrol from a
  fallback login.
- Subdomains can share an rpID but a different registrable domain cannot.

This is flagged in `docs/archive/BACKBONE.md` §5 and §12 and it is the single
irreversible thing in this project. **Confirm the domain is permanent before
the first registration ships**, not after.

## 3. The multi-device question, answered

The common consumer pattern — password + MFA first, passkey offered afterwards
as a convenience — exists because big services onboard strangers on unknown
devices and need one fallback that always works. Den mints every account by
hand through an invite; that out-of-band trust channel is the thing large
services have to synthesize. So the shape differs, and "how do I sign in on my
laptop?" has three answers, in the order they will actually occur:

1. **The passkey is already there (most common).** Platform passkeys sync. An
   iPhone passkey in iCloud Keychain is available on that user's Mac; a passkey
   saved to Google Password Manager is available across their Android and
   Chrome profiles. For most of the circle, signing in on a second device
   involves no enrolment at all.
2. **Cross-device auth (hybrid, "caBLE") covers the mismatch.** Laptop shows a
   QR code, the phone holding the passkey scans it and approves over BLE, the
   laptop gets a session and then offers to register a *local* passkey. This is
   precisely the "go through the default route once, then set up a passkey for
   this device" flow — except the first factor is a device you are holding
   rather than a guessable string.
3. **Password fallback.** Still there, still throttled, for the friend on a
   borrowed Windows machine or an old browser.

**One account, N credentials, is the normal state, not a workaround.**
`webauthn_credentials` is already a many-rows-per-user table
(`server/src/db/schema.ts:118`) and the flow below labels each one so the
Settings list reads "iPhone", "Laptop" rather than opaque IDs.

## 4. Scope

**In:**
- Add a passkey from Settings (requires an existing session — a logged-in user
  is the only person who may attach a credential to their account).
- Sign in with a passkey from `AuthScreen`, discoverable-credential style: one
  tap, no username typed.
- List / rename / remove passkeys in Settings, guarded by the ≥1-login-method
  rule.

**Out (deliberately):**
- Passkey-only *registration*. Account creation stays invite + password. It
  keeps one creation path instead of two, and it guarantees every account has
  the fallback from day one.
- Removing password login. Settled against — see §9. Passwords are the
  permanent fallback, which means the login throttle stays load-bearing rather
  than becoming scaffolding this feature retires.
- OAuth. Roadmap #2, untouched here. Do not reuse `/auth/oauth/*`.

## 5. Data model

`webauthn_credentials` already exists from migration 001 and needs **no
migration** — this is the INSERT-pattern payoff the table was created for:

| Column | Use |
|---|---|
| `id` | credential ID (base64url), PK |
| `user_id` | owner |
| `public_key` | COSE key, `bytea` |
| `sign_count` | replay signal — see below |
| `transports` | `internal` / `hybrid` / …, improves the browser's prompt |
| `device_label` | user-facing name in Settings |
| `created_at` / `last_used_at` | Settings list, and "you have not used this in a year" |

**`sign_count`:** authenticators that implement it increment per assertion; a
counter that goes *backwards* means a cloned credential. Most platform
authenticators (Apple, Google) always report `0` — so the rule is: if both
stored and presented are `0`, ignore it; otherwise require strictly increasing
and reject if not. Do not treat a `0` as an attack, and do not skip the check
for the authenticators that do report it.

**Challenges** need somewhere to live for the ~60s between `options` and
`verify`. Follow the existing precedent rather than inventing one: Vault's
OAuth PKCE state rides a **short-lived, httpOnly, path-scoped cookie** and that
code explicitly reasoned that a cookie *is* the "one-time row"
(`server/src/routes/integrations-vault.ts:13-15`). Do the same — a signed,
httpOnly, `SameSite=Lax`, path-scoped, ~2-minute cookie holding the challenge.
No new table, no server memory that breaks across a restart or a second
process. The registration variant additionally binds to the session user.

## 6. Routes

Exactly the paths reserved in `docs/archive/BACKBONE.md` §6 — these were held
open for this and must not drift:

```
POST   /auth/passkey/register/options    (requireAuth — add to my account)
POST   /auth/passkey/register/verify     (requireAuth)
POST   /auth/passkey/login/options       (unauthed; no username field)
POST   /auth/passkey/login/verify        (unauthed → creates a session)
GET    /auth/passkey/credentials         (requireAuth — Settings list)
PATCH  /auth/passkey/credentials/:id     (requireAuth — rename)
DELETE /auth/passkey/credentials/:id     (requireAuth — ≥1-login-method guard)
```

`login/verify` mints a session through the **existing** `createSession`
(`server/src/auth/session.ts:54`) — same cookie, same 30-day rolling expiry,
same table. Passkeys change how you prove identity, never what a session is.

Library: `@simplewebauthn/server` + `@simplewebauthn/browser`, as named in the
archived plan. ⚠️ This is a **new dependency** and CLAUDE.md requires an owner
decision for that. It is the right call — hand-rolling CBOR/COSE/attestation
parsing is exactly the kind of code that is wrong in ways nobody notices — but
it needs a yes. **Approved and installed 2026-08-26**: `@simplewebauthn/server`
in `/server`, `@simplewebauthn/browser` in `/app`. `@simplewebauthn/browser` is
a small first-party bundle import, not a CDN script, so invariant 10 is
satisfied.

Ceremony options: `residentKey: 'required'` + `userVerification: 'preferred'`,
so login is discoverable (no username typed). `attestation: 'none'` — we do not
care which hardware made the key, and asking for attestation triggers scarier
OS prompts for zero benefit in a friend circle.

## 7. ⚠️ How this interacts with the login throttle

This section is the reason to do passkeys next rather than later.

`docs/AUTH_HARDENING.md` §2.2 accepted a real cost: because the per-account
lock is checked before the password is verified, someone who knows a username
can lock its owner out for up to 15 minutes. Passkeys dissolve that, but only
if three rules are followed:

1. **The password lock must NOT gate passkey login.** A passkey assertion is a
   cryptographic proof — it cannot be brute-forced, so throttling it protects
   nothing, and refusing it during a password lock would rebuild the lockout
   DoS behind a different door. `checkLock` belongs on the password path only.
   With that rule, a locked-out user just taps their passkey and is in — the
   attacker's lockout becomes an inconvenience that routes around itself.
2. **A successful passkey login clears the account's failure rows**, exactly as
   a successful password login does (`clearFailures`). Proving who you are
   resets your counter, whichever way you proved it.
3. **The push alert stays.** A lock still means someone is attacking the
   account, and the owner should still hear about it even though it no longer
   blocks them.

`/auth/passkey/login/options` should keep the ordinary flood backstop, since it
is an unauthed endpoint that does work. Nothing more.

## 8. Client

- **`AuthScreen.tsx`** (`app/src/components/AuthScreen.tsx:13`) gains a "Sign in
  with a passkey" button above the username/password fields. It calls
  `login/options` → `startAuthentication()` → `login/verify`. The existing
  `mode` state (`'login' | 'register'`) is untouched; this is a third entry
  point, not a fourth mode.
- **`Settings.tsx`** (`app/src/components/Settings.tsx:29`) gains a
  `PasskeysSection` alongside `MediaPrivacySection` / `NotificationsSection` /
  `VaultLinkSection`, following the same section shape. Lists credentials with
  label, created and last-used; "Add a passkey" runs the registration ceremony;
  each row has rename and remove.
- **Post-registration nudge:** after a *new* account's first login, offer to add
  a passkey once. Once, then never again — a friend circle does not need to be
  nagged.
- Styling stays plain; the owner does a UI pass separately.

## 9. Recovery model — DECIDED: Option A

**Owner's call, 2026-08-26: passwords stay. No per-user retirement, now or as a
near-term follow-up.** The reasoning given: Tier 0 already bounds brute force,
which is sufficient for a five-person circle, so the residual risk of keeping a
guessable secret is one the owner is content to carry. Build Option A; treat
Option B as iceboxed rather than "next".

Practical consequences for whoever implements this:

- Every account keeps a usable password forever. The per-account throttle in
  `auth/throttle.ts` therefore stays load-bearing indefinitely — it is not
  scaffolding to be removed once passkeys land.
- No `recovery_codes` table, no `invite_codes.kind` column, no recovery
  ceremony. Losing every device means signing in with the password.
- The ≥1-login-method guard still counts passkeys and password together, so
  DELETE-credential is written once and stays correct if Option B is ever
  revisited.
- §7's rules still all apply — they are what make the password lock survivable,
  and under Option A that lock never goes away.

The original comparison is kept below for the record.

**Option A — password stays forever as fallback (zero extra work).** Every
account keeps its password. Passkeys are the fast, safe primary path; the
password is the "I'm on a borrowed laptop" path. Cost: the guessable secret
never goes away, so the throttle keeps carrying real weight indefinitely.

**Option B — passkeys become primary and the password can be retired
per-user.** A user with ≥2 registered passkeys may remove their password
entirely, at which point their account has no brute-forceable surface at all.
Losing every device then means owner-issued recovery: mint a single-use
recovery code with the existing invite CLI pattern, hand it over out of band,
it authorizes one passkey registration. Cost: a small `recovery_codes` table
(or a reuse of `invite_codes` with a `kind` column) and a careful
≥1-login-method guard that counts passkeys and password together.

**Chosen: A.** B remains possible later without a rewrite — the ≥1-login-method
guard counting both kinds from the start is what keeps that door open — but it
is not planned work. See PROJECT.md §13 icebox.

## 10. iOS reality (PROJECT.md §12)

Dev device is Android; most users are on iPhone. Everything here needs the
real-device gate, and these are the specific things expected to diverge:

- **Installed-PWA passkey ceremonies.** iOS 16+ supports WebAuthn in standalone
  display mode, but the prompt sheet behaves differently from Safari-tab mode.
  This is the highest-risk unknown in the whole feature — verify it before
  anything else, because if registration is broken in the installed PWA the
  feature is broken for most of the circle.
- **User-gesture requirement.** Both ceremonies must start from a direct tap.
  Never trigger one from an effect, a redirect, or after an `await` that could
  break the gesture chain — the same rule that already governs push permission.
- **Conditional UI / autofill** (`mediation: 'conditional'`) is unreliable in
  standalone mode. Use an explicit button, not autofill-driven login. Do not
  build a flow that depends on conditional UI existing.
- **Cross-device (QR) flow** is the path most likely to surprise on a
  locked-down device; test iPhone-passkey → laptop explicitly rather than
  assuming it follows from the same-device case.
- Android (the dev device) will work first and prove the least. Do not read a
  green Android run as the feature being done.

## 11. Verification

Run 2026-08-26 against the compose stack. `scripts/probe-passkey.ts` drives the
real HTTP ceremonies with a **software authenticator** built in the script — a
P-256 keypair, correctly assembled `authenticatorData`, a `none`-format
attestation object, and real ES256 signatures. That is the point: a probe that
mocked the crypto would pass while the verification path was broken, which is
the only part worth testing.

**All 20 checks pass.**

| Area | Checks |
|---|---|
| Register | options issued · attestation verified (201) · credential listed with its label |
| Login | options issued · assertion accepted · session belongs to the right user |
| Tamper | a signature with one flipped byte is refused `passkey_failed` |
| Replay | first use of a challenge accepted; **reuse of the same challenge refused** |
| Cross-account | another user's rename → 404 · their delete → 404 · it never appears in their list |
| **Throttle (§7)** | password login locked (precondition) · **passkey login still succeeds while locked** · **passkey login cleared the failure counter** |
| Removal | own credential removable while a password remains · list empties |
| Sign count | a counting authenticator registers · advancing counter accepted · **regressed counter refused** · **repeated counter refused** |

The three bold rows in Throttle are the ones this feature could not ship
without: they are the proof that the lockout-DoS tradeoff
(`docs/AUTH_HARDENING.md` §2.2) is actually retired rather than merely
described as retired. Sections 1–7 also prove the *other* half of the
sign-count rule implicitly — that authenticator reports a permanent `0`
throughout, exactly as Apple and Google do, and is accepted every time.

Gates: `npm run typecheck` and `npm run lint` clean (no new warnings);
`npm run test` — 98 tests, 98 pass.

**Two findings from the run, both worth keeping:**

1. `expectedOrigins()` is a real allow-list, and the first probe run failed
   registration outright because the test server was on a port not in it. That
   is the control working. It is also why the origins list has a unit test that
   trips if an unexpected host ever appears in it.
2. The probe's own DELETE requests were 400ing before reaching the handler,
   because it sent `content-type: application/json` with no body and Fastify
   rejects that. It looked exactly like a broken route. `lib/api.ts` sets that
   header only when a body exists, so the real client was never affected — but
   it is a good reminder that a probe which doesn't mimic the actual client can
   manufacture its own bugs.

### Still outstanding — the iOS gate (§10)

None of the below is verified, and the first item gates the rest:

- Registration and login ceremonies **inside the installed PWA** on iOS 16+.
- The user-gesture chain surviving from tap to ceremony on iOS (the code calls
  both ceremonies directly from `onClick`, which is what this depends on).
- Cross-device (QR) sign-in: iPhone passkey → laptop.
- That the Settings list renders sanely on a narrow viewport.

Android is the dev device and will work first while proving the least.
