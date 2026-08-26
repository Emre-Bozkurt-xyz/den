# Auth hardening — Tier 0

Status: **implemented** 2026-08-26. Scope is deliberately narrow: make the
existing invite + password login safe to leave exposed on the public internet.
No change to the auth *model* — no OAuth, no passkeys, no MFA. Those are
roadmap items 1–2 (PROJECT.md §13) and this work is designed to sit under them
rather than in their way.

## 1. What was actually wrong

Measured against prod (`den.ems-place.com`) on 2026-08-26 with
`server/src/scripts/probe-proxy-trust.ts`:

```
v6 client 2a09:bac5:… → 10 attempts → 429, bucket exhausted
v4 client 104.28.216.174 (a different real IP) → 429 immediately
```

Two different real client addresses landed in **one shared bucket**. The login
rate limit (`routes/auth.ts`, `max: 10, timeWindow: '1 minute'`) was global,
not per-client. Consequences, in order of severity:

1. **Login was trivially DoS-able.** Ten wrong passwords a minute from anywhere
   locked out *every member of the circle*, for as long as the attacker cared
   to keep going. This is the real bug — cheaper to exploit than the thing the
   limiter was built to stop.
2. **No per-account bound.** All throttling was per-"IP". An attacker with the
   global bucket to themselves got 14.4k guesses/day against every account at
   once.
3. **No record.** Failed logins were neither counted nor logged. A slow grind
   would leave nothing behind.

The root cause is that **the real client IP never reaches Fastify.** The chain
is Cloudflare → VPS → frp tunnel → Caddy → Fastify, and the client address is
lost somewhere before Caddy. `app.ts` set `trustProxy: true`, so `req.ip` read
the leftmost `X-Forwarded-For` entry — but a forged `X-Forwarded-For` provably
did *not* buy a fresh bucket, so no client-controlled XFF is arriving either.
`req.ip` is a constant.

⚠️ `trustProxy: true` with a client-supplied XFF *would* have been a
spoofable-limiter bug. It isn't one today only because the header is being
dropped upstream. That is luck, not design — if the tunnel config ever starts
forwarding XFF, trust-all turns the limiter into decoration. Hence the fix
below pins trust explicitly instead of leaving it at `true`.

## 2. Design

### 2.1 Stop guessing at the client address

`server/src/auth/clientIp.ts` resolves the client from an **explicitly
configured** source rather than "trust whatever header showed up":

| `TRUSTED_PROXY` | `clientIp()` reads | Use when |
|---|---|---|
| `none` (default) | the socket peer address | no proxy, or the chain doesn't forward the client |
| `cloudflare` | `CF-Connecting-IP`, else socket peer | Cloudflare reaches the origin intact |
| `xff` | rightmost `X-Forwarded-For` entry, else socket peer | a single trusted proxy that appends |

Default is `none` because that is the only value that cannot be tricked. The
correct prod value is **not yet known** — `GET /api/debug/client-ip` (§2.5)
exists to determine it, and until it's set, the per-account throttle (§2.2) is
what's actually protecting the door. `app.ts`'s `trustProxy` is likewise now
env-driven (`TRUST_PROXY`, default off) instead of a hardcoded `true`.

### 2.2 Per-account throttle — the part that does the work

An IP-keyed limit cannot protect this login form while the IP is a constant,
and would only be worth so much if it weren't: rotating addresses is cheap.
The username is the one part of the request an attacker cannot rotate away
from, so the real bound is keyed there.

`login_failures` (migration 0015) is an append-only row per failed attempt:
`username` (as submitted, normalized), `ip` (best-effort), `user_agent`,
`created_at`. On each login:

1. Count failures for that username inside `WINDOW` (15 min).
2. `n >= THRESHOLD` (10) → **423 Locked**, `auth_locked`, *before* the password
   is verified. Lock runs until `last_failure + backoff(n)`, where backoff
   doubles from 1 min and caps at 15 min.
3. Otherwise verify as before. A failure appends a row; a success **deletes the
   account's failure rows**, so a legitimate login always clears the state.

Rows are recorded for usernames that don't exist, too. That's deliberate — a
lock that only applied to real accounts would be an enumeration oracle, which
would undo the `DUMMY_HASH` work in `routes/auth.ts`.

**⚠️ The tradeoff, stated plainly:** a hard lock means someone who knows your
username can lock you out by spamming wrong passwords. That is a real cost and
it is chosen knowingly, because the alternatives are worse here:

- *Admit a correct password even while locked* removes the DoS but also removes
  the guess-rate bound entirely — the attacker just keeps submitting, and the
  server keeps paying argon2 for it. It becomes an alarm, not a limit.
- *Delay the response instead of rejecting* ties up connections and is
  sidestepped by issuing guesses in parallel.

The lock is made survivable rather than eliminated: it caps at 15 minutes, it
notifies the account owner (§2.4), and `npm run auth:unlock <username>` clears
it instantly. For a five-person circle, "wait 15 minutes or run one command,
and you get told it happened" is an acceptable worst case; unbounded password
guessing is not.

### 2.3 The global limiter becomes a backstop, not the defense

`@fastify/rate-limit` stays on the auth routes but is re-aimed: `max` rises
from 10/min to 120/min so it stops being a one-attacker outage switch, and it
keys off `clientIp()` so it becomes per-client the moment `TRUSTED_PROXY` is
configured correctly. It now catches pathological floods only; §2.2 handles
credential guessing.

### 2.4 Tell the owner

A lock triggers **one** web push to the locked account's owner (`notifyUser` in
`push/notify.ts`, extracted from the existing chat fanout — same TTL/urgency
path, `topic: 'auth-alert'`). ⚠️ It fires on the attempt that *crosses* the
threshold, not on `locked === true` — that stays true for every subsequent
failure, so alerting on it would push a notification per guess and hand an
attacker a way to make someone's phone buzz all night. Failures are also logged
at `warn`. Push is strictly fire-and-forget: it can never affect the login
response.

### 2.5 Finish the IP question

`GET /api/debug/client-ip` (**requires a session**) echoes the resolved client
plus the candidate headers Fastify actually received. Authenticated so it
reveals nothing to a stranger, and it only ever describes the caller's own
request. Run it once from a phone on mobile data and the correct
`TRUSTED_PROXY` value is immediate.

## 3. What this does NOT do

- No MFA, no passkeys, no OAuth (roadmap 1–2).
- No session revocation UI / "log out other devices". `sessions` already stores
  `user_agent`, so this is cheap later — it is out of Tier 0 scope.
- No password strength or breach check. The five existing passwords are
  unaudited; a floor raise is a separate, user-visible change.
- No Cloudflare WAF rule. The domain is already proxied through Cloudflare
  (confirmed: `Server: cloudflare`, `CF-RAY` present), so a rate-limit rule on
  `/api/auth/login` is available as config-only work with no code change.

## 4. Verification

Run 2026-08-26 against the compose stack (Postgres on 5434, API on a spare port
so an existing dev server was left alone), migration 015 applied.

`scripts/probe-auth-throttle.ts` — all checks passed:

```
1. 10 failed logins for "probe-bcd317ed2e6a"  → locked after 11 attempts
   PASS  account locks after repeated failures      — 423 auth_locked
   PASS  lock uses the auth_locked code
   PASS  lock sends Retry-After                     — Retry-After: 60
   PASS  lock message tells the user when to retry
2. a different account during the lock
   PASS  bystander is NOT locked out                — 401 invalid_credentials
```

Check 2 is the one that matters most: it is the regression test for the bug
this work exists to remove. If a locked account ever takes a bystander down
with it, the global-bucket outage has been rebuilt in a new place.

Also verified by hand, beyond what the probe covers:

| Path | Result |
|---|---|
| Success clears the counter — real account, 9 wrong then the right password | 9 rows → `200` → **0 rows** |
| Backoff escalates — 10 failures backdated 90s (first lock elapsed, still in window), then two more attempts | `401` (row 11 recorded) → `423` with **Retry-After: 120** |
| `auth-unlock status` | lists both usernames, marks one `LOCKED for 50s` |
| `auth-unlock clear <username>` | `Cleared 10 failure row(s)`; next attempt `401`, not `423` |
| Flood backstop ceiling | `x-ratelimit-limit: 120` |
| `GET /debug/client-ip` unauthenticated | `401` |
| `GET /debug/client-ip` with forged `X-Forwarded-For: 66.66.66.66, 10.1.1.1` under `TRUSTED_PROXY=none` | `resolved: 127.0.0.1` — the forged leftmost is ignored, and `xForwardedForRightmost` correctly reports `10.1.1.1`, not `66.66.66.66` |

Note the escalation row incidentally confirms a designed-in property that is
easy to misread as a bug: **no failure is recorded while an account is locked**,
because the gate throws before the verify. The count only passes the threshold
after a lock elapses inside the still-open 15-minute window — which is exactly
when a longer lock is warranted.

Gates: `npm run typecheck` and `npm run lint` clean. `npm run test` — **91
tests, 91 pass, 0 fail** with the compose stack up. (Without a reachable
Postgres the DB-backed integration suites fail; that is an environment
condition, not a code one — it reproduced identically on a stashed working tree
before any of this work.)

### ✅ Closed 2026-08-26: prod is per-client

`TRUSTED_PROXY=cloudflare` is set in prod and verified:

```
limit 120/min · v4 counter moved by 1 across 5 v6 requests + 1 v4 request
PER-CLIENT ✓ — a forged header is ignored, and two different real clients get
  separate buckets.
```

`CF-Connecting-IP` carries the real client to the origin (confirmed via
`/api/debug/client-ip` from a phone on mobile data); `X-Forwarded-For` only
ever holds the Docker gateway, so the `xff` strategy would have been wrong.

⚠️ **The remaining assumption:** trusting `CF-Connecting-IP` is only sound while
the origin cannot be reached *around* Cloudflare. Anyone who can hit the VPS
directly can forge that header and choose their own bucket. Restricting the
VPS to Cloudflare's IP ranges (or moving to a Cloudflare Tunnel) is what makes
this airtight. Not urgent — the per-account throttle does not depend on the
address at all, which is exactly why it is keyed on the username.

⚠️ **The probe silently rotted and this is worth remembering.** It drove the
limiter to 429 with a hardcoded 12 attempts, which worked against the original
10/min ceiling and proved nothing the moment §2.3 raised it to 120 — it just
reported INCONCLUSIVE, which reads like "couldn't tell" rather than "this tool
is broken". It now *measures the counter* instead of exhausting it: cheaper,
immune to the limit changing, and it no longer briefly consumes everyone's
login allowance to run. **A verification tool with a hardcoded assumption about
the thing it verifies will stop verifying without saying so.**

Previously outstanding:

- ~~**Set `TRUSTED_PROXY` in prod.**~~ Sign in on a phone over mobile data, hit
  `/api/debug/client-ip`, and see which candidate shows the phone's real
  address. Until then the strategy is `none` and the flood backstop is
  effectively global — harmless now that it is 120/min and the per-account
  throttle carries the load, but it is not finished.
- Re-run `scripts/probe-proxy-trust.ts` against prod afterwards; the verdict
  should move from SHARED to PER-CLIENT.
- No iOS-divergent UI in this change (server-side only, plus one `sw.ts` field),
  so nothing new for the §12 device gate. The lock message surfaces through
  `AuthScreen`'s existing error line.
