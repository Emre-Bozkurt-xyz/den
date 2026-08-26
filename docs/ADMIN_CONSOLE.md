# Admin / security console — plan

Status: **BUILT** 2026-08-26 (migration 016) — both halves. Verified against
the compose stack with a 55-check probe; see §10. Passkeys shipped first, as
§1 requires.

✅ **Browser-verified by the owner 2026-08-26** — the console renders, the
actions work, and the re-auth prompt correctly retries the pending action
without the user pressing anything twice (the fiddliest path in the client).
⚠️ Still unverified on iOS specifically; the §8 layout note (stacked cards,
never sideways-scrolling tables) has only been seen on Android.

Shape settled by the owner: **owner-only**, **inside the PWA** (a section of
Settings, not a separate app or subdomain).

Motivating observation, in the owner's words: the automated controls handle
things *silently*, and warnings should exist besides them. That is the same
failure mode as the 2026-08-23 notification rework — a system inferring state
that nobody could see. Everything below is in service of making Den's security
posture legible to exactly one person.

## 1. ⚠️ Why this ships after passkeys

Building this makes the owner account the highest-value target in Den. Today
every account is worth the same: a stolen session reads that person's chats.
After this, a stolen *owner* session can mint invites, revoke everyone's
sessions and disable accounts.

So the account that gains those powers should be the hardest one to steal
before it gains them, not after. Passkeys (`docs/PASSKEYS.md`) remove the
guessable secret from the owner's login entirely. Doing this first would mean
running the highest-privilege account on a password for however long passkeys
take — which is precisely the window an attacker would want.

This is also why §6 requires re-authentication for destructive actions: once
passkeys exist, that re-auth is a passkey tap, which is both stronger and
less annoying than a password prompt.

## 2. ⚠️ The line this must not cross

Hard invariant 1 says authorization is chat membership, and that is the app's
entire privacy model. An admin console is the first authorization concept in
Den that isn't membership, so the boundary has to be stated before anything is
built:

> **The owner is an operator, not a reader. No admin surface ever exposes
> message content, media bytes, captions, tags, embeds, or chat membership.**

The owner may see *that* an account exists, when it last signed in, how many
credentials it has, and what security events it produced. The owner may **not**
see who talks to whom, or what anyone said. Admin routes therefore never join
to `messages`, `media`, `embeds`, `chat_members`, or `chats`.

This keeps invariant 1 fully intact rather than carving an exception into it:
chat-scoped routes still authorize by membership, and admin routes simply are
not chat-scoped. If a future admin feature seems to need chat content, that is
a signal to redesign the feature, not to widen the rule.

`assertMember` stays the only path to chat data. `requireOwner` (§4) is a
parallel gate over a disjoint set of routes, never a bypass of the first.

## 3. What goes in it

Everything here is CLI-only or invisible today. That is the selection rule —
this console exposes what already exists operationally, it does not invent new
powers.

**a. Security feed (the headline).** A reverse-chronological list of
`security_events` (§5): account locked, unusual failure burst, new-device sign
in, credential added or removed, invite claimed, session revoked, account
disabled. Filterable by user and by event type. This is the "proper warning
system" — the push alert Tier 0 sends on lock becomes one *view* of this feed
rather than the only trace an event ever leaves.

**b. Locks & failed logins.** Current locks with time remaining, recent failure
counts per username, one-tap unlock. Replaces `npm run auth:unlock status|clear`
(`server/src/scripts/auth-unlock.ts`), which stays as the break-glass path for
when the PWA itself is what's broken.

**c. Invites.** Mint, list (used/unused, who claimed, when), and **revoke an
unused code** — that last one does not exist at all today, in the CLI or
anywhere. Replaces `npm run invite create|list`.

**d. Users.** One row per account: username, display name, joined, last seen,
and a **credential inventory** — has a password? how many passkeys? Vault
linked? Actions: disable / re-enable (§7). No message counts, no chat lists —
see §2.

**e. Sessions.** Per user: device label from `sessions.user_agent`, created,
expires. Actions: revoke one, revoke all for a user. Session revocation does
not exist anywhere today, which means a lost phone currently has no answer
short of a password change.

**f. Push health.** Subscription count per user and last successful send, so
"I don't get notifications" is diagnosable instead of debated. `push_subscriptions`
already self-heals on 404/410 (docs/NOTIFICATIONS.md); this makes the churn
visible.

**Explicitly out:** anything touching chat content (§2), server metrics or
uptime dashboards (that is what the host is for), and bulk destructive actions
— hard-wipe stays iceboxed and still requires an explicit logged override
(invariant 8).

## 4. Who is the owner

**Recommendation: a `users.is_owner` boolean, granted only by CLI.**

Migration adds `is_owner boolean NOT NULL DEFAULT false`. A new
`npm run owner grant|revoke|list <username>` sets it, following the
`scripts/invite.ts` pattern exactly. **There is no in-app path to grant it** —
no settings toggle, no API route, not even for an existing owner. Privilege is
conferred from the host shell, which means an attacker who fully controls a
session still cannot escalate.

Alternatives considered:

- **Env var (`OWNER_USERNAME`).** Tempting because a database write could then
  never confer admin. Rejected: it cannot be joined against, so every admin
  query would resolve it in application code; and a Postgres compromise already
  means total data access, so the property it buys is smaller than it looks.
- **A roles table.** Correct for a product with many privilege levels; here it
  would be one row with one value forever. Build it the day a second role
  actually exists.
- **Implicit "user id 1" / first account.** Rejected outright — implicit
  privilege that nothing declares is exactly the kind of rule that rots
  silently, and `invite_codes.created_by` being nullable for bootstrap shows the
  codebase already prefers explicit nulls to positional magic.

`MeResponse` (`shared/src/api.ts:89`) gains `isOwner: boolean`, riding the
existing `/me` fetch for the same reason `gifsEnabled` does — the client needs
it on first paint to decide whether to render the entry point. ⚠️ It is a
**display hint only**; every admin route re-checks server-side. A client that
lies to itself about `isOwner` gets 403s, not data.

## 5. Data model

**New: `security_events`** — append-only, the substrate the whole console reads
from.

| Column | Notes |
|---|---|
| `id` | bigint identity PK |
| `kind` | `'login.locked'`, `'login.failed_burst'`, `'session.new_device'`, `'credential.added'`, `'credential.removed'`, `'invite.claimed'`, `'invite.revoked'`, `'session.revoked'`, `'user.disabled'`, `'user.enabled'`, `'owner.action'` |
| `user_id` | nullable FK — the account the event is *about*; null when the username never existed |
| `username` | text, as submitted; survives a user that never existed or was later removed |
| `actor_user_id` | nullable FK — who *did* it, when an owner action. Null for system-generated events |
| `ip` / `user_agent` | best-effort, same caveat as `login_failures` |
| `data` | jsonb for kind-specific extras — keep flat, JSON-primitive, like `users.settings` |
| `created_at` | timestamptz |

Indexes on `(created_at DESC)` and `(user_id, created_at DESC)`.

⚠️ **This does not duplicate `login_failures`, and the difference is
load-bearing.** `login_failures` is a *live counter*: rows are deleted the
moment a user logs in successfully, because its job is to answer "is this
account locked right now?" (`docs/AUTH_HARDENING.md` §2.2). `security_events`
is *durable history*: nothing ever deletes from it, because its job is to
answer "what happened last Tuesday?". Merging them would break one of the two —
either the counter stops clearing on success, or the history evaporates every
time an attack ends. Keep both; have the lock path write to both.

**Retention:** events are small and Den has five users, so keep everything for
now. If it ever needs bounding, prune by age in the same opportunistic sweep
`auth/throttle.ts:sweepExpired` already uses — Den still has no job runner and
this feature must not be the thing that introduces one.

**Also new:** `users.disabled_at` (nullable timestamptz) for §7, and
`invite_codes.revoked_at` (nullable timestamptz) for §3c. Both soft, per
invariant 8.

One migration covers all three.

## 6. Routes

All under `/api/admin/*`, all behind `requireOwner`:

```
GET    /admin/events?before=&kind=&userId=     (keyset on id DESC, per conventions)
GET    /admin/locks                            · POST /admin/locks/:username/clear
GET    /admin/users                            · POST /admin/users/:id/disable | /enable
GET    /admin/users/:id/sessions               · DELETE /admin/sessions/:id
DELETE /admin/users/:id/sessions               (revoke all for that user)
GET    /admin/invites                          · POST /admin/invites
DELETE /admin/invites/:code                    (revoke an unused code)
GET    /admin/push-health
```

`requireOwner` is a preHandler composed **after** `requireAuth`
(`server/src/auth/session.ts:127`), mirroring how chat routes layer
`assertMember` on top of it: authentication and authorization stay separate
gates, and this adds a third kind of the latter rather than blurring the
existing two.

**Re-authentication for destructive actions.** Disable-user, revoke-all-sessions
and invite-revoke require a fresh proof of identity from within the last ~5
minutes, not merely a valid session. Once passkeys land (§1) that is one tap.
Implement it as a short-lived marker set by a successful re-auth ceremony —
same cookie pattern as the WebAuthn challenge (`docs/PASSKEYS.md` §5), not a
new table.

**Every owner action writes a `security_events` row** with `actor_user_id` set.
The console's own audit trail is not optional: an admin surface that cannot say
who did what is worse than no admin surface, because it manufactures deniability.

Rate-limit admin routes with the ordinary backstop. They are authenticated, but
`global: false` means opt-in and forgetting is the default failure.

## 7. Disabling an account

`users.disabled_at` set → all of that user's sessions deleted, and
`resolveSession` refuses to resolve for a disabled user (so a live socket dies
on its next authenticated action). Login and passkey login both refuse with a
distinct error code.

⚠️ **Disabling is not deleting.** Messages, media and memberships are untouched
— the person simply cannot sign in. Actual account deletion is a much larger
question (their messages are part of other people's conversations) and is
**not** in this plan; it belongs with the iceboxed hard-wipe work.

The owner cannot disable themselves. Guard it explicitly rather than relying on
nobody trying it.

## 8. Client

- `MeResponse.isOwner` gates a single **Admin** entry in `Settings.tsx:29`,
  alongside the existing sections. Non-owners never see it, and the routes 403
  regardless.
- The console itself is a stack of plain sections following `Settings.tsx`'s
  existing shape (`ScreenHeader` + `max-w-lg` column + `overflow-y-auto`), one
  per §3 area. Registers on `backStack` like every other overlay.
- ⚠️ **Layout is the real design problem, not the logic.** Six of these views
  are naturally tables and most users are on phones. Use stacked cards on
  narrow viewports rather than horizontally-scrolling tables; if a table is
  unavoidable it goes in its own `overflow-x` container so the page body never
  scrolls sideways.
- Styling stays plain — the owner does a UI pass separately.
- Nothing here is iOS-divergent by nature (no media, no gestures, no
  permissions), which is a welcome change. The one thing to check on the device
  gate is that a data-dense scrolling list inside the installed PWA respects
  `100dvh` and the safe-area insets like every other screen.

## 9. Build order

1. `security_events` + the three columns (one migration), and start **writing**
   events from the paths that already exist — the Tier 0 lock path first. The
   feed has history from day one this way instead of starting empty.
2. `users.is_owner` + the owner CLI + `requireOwner` + `MeResponse.isOwner`.
3. Read-only console: events feed, users, sessions, locks, push health.
4. Actions, each with its `security_events` row: unlock, revoke session,
   revoke invite, mint invite.
5. Re-auth gate (§6), then the destructive actions behind it: disable/enable.

Steps 1–3 are safe to build and ship independently; nothing in them can change
state. That split is deliberate — it means the risky half is a small, separate,
reviewable change rather than a rider on a large one.

## 10. Verification

`scripts/probe-admin.ts`, run 2026-08-26 against the compose stack — **all 30
checks pass**.

| Area | Checks |
|---|---|
| Locked down | all 5 routes → 403 for a non-owner · unauthenticated → 401 · `me.isOwner` false before the grant |
| Grant | `me.isOwner` true after a direct DB write (what the CLI does) · the *other* user still refused |
| Owner reads | all 5 routes → 200 |
| **§2 boundary** | a real chat + message is seeded containing a unique marker, then every response is checked for **(a)** a 200 status, **(b)** no chat-shaped field, **(c)** no echo of the message text |
| Session tokens | listed ids are truncated hashes · **a listed id used as a cookie → 401** · the current session is flagged |
| Feed | `invite.claimed` recorded · `login.locked` recorded after a real lock · the lock appears in the locks panel |

The boundary block is the one that matters. It is written as an invariant
check rather than a unit test precisely because the risk here is *drift*: a
future panel that joins to `messages` for something innocuous would fail this
probe rather than a code review.

**Two findings from the run, both kept:**

1. **`/admin/users` 500'd on `operator does not exist: bigint = text`.**
   Drizzle emits **unqualified** column names inside a `sql` template, so
   `${webauthnCredentials.userId} = ${users.id}` became
   `where "user_id" = "id"` — and inside a correlated subquery, `"id"` binds to
   the *subquery's* table (`webauthn_credentials.id`, a text credential ID),
   not `users.id`. The correlated counts are now literal, table-qualified SQL
   with aliases, kept visible in the module per CLAUDE.md. ⚠️ Any future
   correlated subquery in this file must do the same.
2. **The boundary scan was passing on a 500.** An error envelope contains no
   chat data, so an outage read as a privacy PASS. The scan now requires a 200
   first. A leak check that a broken endpoint satisfies is worse than no check,
   because it reports safety.

Gates: `npm run typecheck` and `npm run lint` clean (no new warnings);
`npm run test` — 98 tests, 98 pass.

### The state-changing half — verified 2026-08-26

| Area | Checks |
|---|---|
| Gate | disable and revoke-sessions without fresh auth → `401 reauth_required` · **clearing a lock and minting invites deliberately do NOT require it** · wrong password refused · right password accepted · **the owner's re-auth marker does not authorize a different account** |
| Actions | sessions revoked and the target's session dies · **the owner's own session survives** · unused invite revoked · revoking twice → 404, not a silent success · **a revoked invite cannot be claimed** |
| Disable | the owner cannot disable themselves · a disabled account cannot sign in with the *right* password · a *wrong* password on a disabled account still says `invalid_credentials` (no enumeration) · re-enable restores sign-in |
| Audit | all six owner actions recorded with the acting username |

**The bug this found, and it was a real one.** Console revocation shipped
marking `invite_codes.revoked_at`, but the registration route's claim query
only checked `used_by IS NULL`. A revoked invite still created an account,
while the console displayed it as "Revoked". **A control that reports success
and does nothing is worse than one that was never built, because it stops
anyone from looking.** The claim now requires `revoked_at IS NULL` too, and
the probe asserts a revoked code is unclaimable rather than merely that the
API returned 200.

Two design points the checks pin down deliberately:

- **Low-harm actions are exempt from re-auth on purpose.** Clearing a lock and
  minting an invite ask for no confirmation. A prompt on every action trains
  the owner to click through it, which is how a confirmation step stops being
  a control. The gate covers the irreversible ones only.
- **Bulk session revocation never touches the caller's own current session.**
  Locking yourself out of the console mid-incident is a real way to make a bad
  situation worse and is trivially avoidable.

**Browser pass, owner, 2026-08-26:** the console renders, every action works,
and `useGuardedAction`'s retry-after-confirm behaves — a revoke prompts once
and then completes on its own. ⚠️ Not yet seen on iOS; the §8 layout note is
confirmed on Android only.

### Original plan for the state-changing half

Definition of done (PROJECT.md §16) plus:

- **The §2 boundary, tested as an invariant, not assumed:** a scripted check
  that no `/admin/*` response body contains message, media or chat-membership
  data, and that no admin query joins those tables. This is the check that
  keeps the privacy model honest as the console grows.
- A non-owner session gets 403 on every `/admin/*` route — enumerated, not
  spot-checked.
- Disabling a user kills their existing sessions immediately and blocks both
  password and passkey login.
- Every state-changing action leaves a `security_events` row naming its actor.
- The owner cannot disable themselves or revoke their own last session.
- Re-auth expiry actually expires: an action attempted 6 minutes after re-auth
  is refused.
