# Deploy — Den

Single-host Docker Compose: **postgres** + **api** (Fastify/socket.io/ffmpeg) +
**web** (Caddy serving the built PWA and reverse-proxying the API/WSS).
Everything is same-origin behind `den.ems-place.com`.

## First run

```bash
# from the repo root
cp .env.example .env
# fill in SESSION_SECRET (long random), POSTGRES_PASSWORD, and VAPID keys:
npm run vapid:gen        # paste output into .env

# --env-file is required: compose otherwise looks for .env next to the compose
# file (deploy/), but ours lives at the repo root.
docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
```

Caddy in this repo's `deploy/Caddyfile` runs **plain HTTP only** — the real
deployment terminates TLS upstream at a reverse proxy on the VPS, which
reaches this host over an frp tunnel (see "CI/CD" below for the full
topology). If you're pointing this compose stack straight at the internet
with no such upstream, you'll need to swap the Caddyfile back to automatic
HTTPS (drop the `http://` scheme on the site address).

For a real prod deploy, use `deploy/.env.prod.example` as the starting point
instead of the root `.env.example` — it has the prod-specific values
(`NODE_ENV=production`, real R2 credentials instead of the MinIO stand-in,
explicit `COOKIE_DOMAIN`, etc.) called out.

## Deploying to prod — `deploy/deploy.sh`

**On the prod host, always deploy with this script — never by hand.** CI runs
the exact same file (`.github/workflows/deploy.yml` is a one-liner calling it),
so there is a single deploy path that cannot drift. That matters: this repo
already had an incident where manual deploys kept working while *every* CI
deploy failed, and the breakage went unnoticed because the manual route
covered for it.

```bash
cd /opt/apps/den/repo
git pull
bash deploy/deploy.sh                       # default env: /opt/apps/den/secrets/.env
bash deploy/deploy.sh --env-file /other/.env
```

What it does, in order:

1. **Preflight**: docker present, env file present, `DEN_DATA_ROOT` set
   **and** its `pg-data/` actually existing, `POSTGRES_PASSWORD` set, and the
   pre-migration backup dir writable. All of it runs before anything touches
   a container, so a misconfigured host fails loudly and changes nothing.
2. **`build`** the new images. Nothing that's running changes yet.
3. **Tag the running `api`/`web` images as `:previous`**, which is the
   rollback target (see below). This only happens while the running api is
   *healthy*, so re-running after a failed deploy can't overwrite the last
   good image with a broken one.
4. **Postgres up + healthy**, then a **pre-migration dump** to the host
   (`backup.sh --local`, see "Pre-migration backups").
5. **Migrate using the new image in a one-off container**
   (`compose run --rm --no-deps api … db:migrate`), while the **old api keeps
   serving**. Drizzle applies pending migrations in one transaction, so a
   failure rolls back. The old code stays up on the unchanged schema, and
   there's nothing to repair.
6. **Swap the api** and **wait for `/health` to really answer** (asked from
   inside the container, then asked again 8s later, with the restart count
   checked to rule out a crash loop). "Container is running" doesn't count.
   On failure the script prints the compose state, the last 60 api log lines
   and the exact rollback command, then exits non-zero.
7. **Swap the rest** (`web`), then **probe `/health` through Caddy**.
8. **Prune** dangling images (`:previous` survives) and print status plus the
   rollback command.

⚠️ **Migrations now run *before* the new code serves**, so for a few seconds
the *old* code runs against the *new* schema. Keep migrations
backward-compatible with the code they replace: add columns and tables, and
rename or drop only in a later deploy, once nothing reads the old shape.
Drizzle-generated migrations are almost always additive. Review any that
aren't.

⚠️ **The api swap includes up to ~40s of drain.** `stop_grace_period: 40s`
on `api` lets in-flight media jobs finish on SIGTERM. `up` blocks for that
stop before the new container starts, and new requests aren't served during
it. The health clock only starts after `up` returns, so a slow drain never
counts against it.

### Rollback (one line, no rebuild)

Each deploy prints its own exact rollback line at the end (and on failure).
With compose's default image names it's:

```bash
cd /opt/apps/den/repo
docker tag den-api:previous den-api && docker tag den-web:previous den-web && \
  docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml up -d --no-build api web
```

`docker image ls | grep previous` shows what's available. Only **one**
previous version is kept per service. A rollback restores **code only**:
migrations are never undone automatically. That's fine for additive
migrations (old code ignores new columns). If the *migration itself* is the
problem, restore the pre-migration dump (below). It's taken seconds before the
migration ran, but restoring it **discards every write since**, so it's a
last resort. After rolling back, the next normal deploy just rebuilds from
`main`.

### Pre-migration backups

Every deploy dumps the database right before migrating, validates it
(`pg_restore --list`), and keeps it **on this host** in `DEN_BACKUP_DIR`
(default `/opt/apps/den/backups`, newest `BACKUP_LOCAL_KEEP`=5 kept, files
`den-<UTC stamp>.dump`, owner-only perms). It needs only the postgres
container, so it still works when the api is down.

- **A failed backup blocks the deploy.** Migrations are the one step a
  redeploy can't undo, and this dump is the undo. In a real emergency, such as
  a broken disk you're deploying around, `DEN_SKIP_BACKUP=1 bash deploy/deploy.sh`
  skips it, with a warning. A brand-new, empty database also needs this,
  because its dump is too small to pass validation.
- **Local, not R2, on purpose.** Pushing every deploy's dump into the nightly
  R2 rotation (`BACKUP_KEEP=7`) would let a busy deploy day evict a week of
  nightly history. The nightly R2 job is still the off-host copy.
- **The dir must be outside both checkouts.** A dump inside one would ride
  along in the next `docker build` context, which is the same trap as
  `deploy/pg-data` (see `.dockerignore`). It must be writable by **both** the
  runner service user and whoever deploys by hand:
  `sudo install -d -m 700 -o "$USER" /opt/apps/den/backups`. Use a shared
  group if those are two different users.
- Restore one exactly like an R2 dump (see "Restoring" below), skipping the
  download step.

### Postgres password

`docker-compose.yml` keeps `${POSTGRES_PASSWORD:-den}` because the same file
serves local dev, where a plain `docker compose up postgres` with no env file
should just work. Prod is protected in `deploy.sh` instead: an **unset/empty**
`POSTGRES_PASSWORD` fails preflight, and the literal default `den` prints a
warning.

`POSTGRES_PASSWORD` is only applied when Postgres **first initialises** its
data dir. Changing it in `.env` alone breaks the api's login. To rotate:

```bash
C="docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml"
NEW="$(openssl rand -hex 24)"            # hex: no URL-special chars (it goes into DATABASE_URL)
$C exec -T postgres psql -U den -d den -c "ALTER USER den WITH PASSWORD '$NEW'"
# now set POSTGRES_PASSWORD=$NEW in /opt/apps/den/secrets/.env, then:
bash deploy/deploy.sh                    # recreates api with the new DATABASE_URL
```

Between the `ALTER USER` and the api restart, connections the api already
has keep working, but new ones fail. Do both steps back to back.

> **Why `bash deploy/deploy.sh` and not `./deploy/deploy.sh`?** Both work. The
> repo is authored on Windows, which can't set the POSIX exec bit on disk; the
> bit is stored in git explicitly (`git update-index --chmod=+x deploy/deploy.sh`)
> so the file *is* executable when checked out on Linux. Calling it through
> `bash` just means a lost exec bit can never break a deploy. If you add
> another script from Windows and Linux says `Permission denied`, that git
> command is the fix — `chmod +x` alone won't survive the commit.

## Notes

- **Postgres** is not published to the host; only the `api` service reaches it
  over the compose network. Data persists in `deploy/pg-data/` (gitignored).
- **MinIO is dev-only** and gated behind a Compose profile — a plain
  `docker compose up` (prod, and the CI deploy workflow below) never starts
  it. To bring it up for local Docker-based dev: add `--profile dev` to the
  `up` command.
- **Migrations & admin CLIs**: run inside the api container. On the prod host
  the repo is `/opt/apps/den/repo` and the env file is
  `/opt/apps/den/secrets/.env` (outside the checkout — see CI/CD below), so
  every compose call needs `--env-file` at that path:

  ```bash
  cd /opt/apps/den/repo
  git pull                                      # see the warning below
  C="docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml"

  # Deploying = `bash deploy/deploy.sh` (backup + migrate-first + health
  # gate). The two lines below are the raw, unguarded pieces, for debugging.
  $C up -d --build api                          # rebuild from the checkout
  $C exec api npm -w server run db:migrate      # migrations
  $C exec api npm run invite create 1           # mint an invite
  $C exec api npm run owner list                # who is an owner
  $C exec api npm run auth:unlock status        # live login locks

  USER=emre                                     # no angle brackets - see below
  $C exec api npm run owner grant "$USER"
  ```

  ⚠️ **`git pull` first, and rebuild.** The image is built from whatever is in
  this checkout — `up -d --build` rebuilding successfully says nothing about
  the code being current. A stale checkout fails in two ways that look
  unrelated: `npm error Missing script: "owner"` (the script isn't in that
  commit's `package.json`) and a migrate run that reports only "schema
  'drizzle' already exists, skipping" — which is drizzle's own bookkeeping, not
  your migration, so it looks like success while applying nothing.

  ⚠️ **Never paste `<placeholder>` into bash.** `<` is input redirection and a
  bare `>` is a syntax error, so `npm run owner grant <username>` dies with
  `syntax error near unexpected token 'newline'` before npm is even reached.
  Every placeholder in this file is a shell variable for that reason.

  ⚠️ **`--env-file` is not optional, even for `exec`.** `docker-compose.yml`
  interpolates `${SESSION_SECRET:?...}`, so compose refuses to parse the file
  at all without it — the failure is `required variable SESSION_SECRET is
  missing a value`, which reads like a broken container rather than a missing
  flag. Locally the same commands work with `--env-file .env` from the repo
  root.

  ⚠️ **Two different env files are in play and they are not interchangeable.**
  The `--env-file` above is read by *compose on the host* to build the
  container's environment. Inside the container there is **no `.env` at all**,
  which is why these npm scripts use `node --env-file-if-exists=.env` rather
  than the strict `--env-file=.env` — the strict form aborts with "file not
  found" before the script runs, so every admin CLI would be host-only. Any new
  admin CLI must use the `-if-exists` form or it will work in exactly one of
  the two places.
- **Check what actually shipped** when something behaves like it wasn't
  deployed:

  ```bash
  git -C /opt/apps/den/repo log --oneline -1     # what the image was built from
  $C exec api sh -c 'npm run 2>&1 | head -30'    # scripts present in the image
  $C exec -T postgres psql -U den -d den -c '\d security_events'
  ```

- **`npm run owner grant` is the ONLY way to make someone an owner**
  (docs/ADMIN_CONSOLE.md §4). There is no API route and no in-app toggle, by
  design — privilege is conferred from the host shell, so a fully compromised
  session cannot escalate. The Admin section appears in Settings on that user's
  next `/me` fetch (reload the app).
- **The api runs as the unprivileged `node` user** (uid 1000), and so does
  everything you `$C exec api …`. Its only writable path is `/tmp` (media
  processing temp dirs). `Dockerfile.api` lists the audit. A new feature that
  writes to disk must use `/tmp`, or pre-create and `chown` its path in the
  Dockerfile. Otherwise it fails with `EACCES`, and if it does that at boot,
  the deploy's health gate catches the crash loop.
- **Images install with `npm ci`** against the committed `package-lock.json`,
  which is required. If `package.json` drifts from the lockfile, the build
  fails (and so does CI's `verify` job, first). Fix it with `npm install`
  locally and commit the lockfile.
- **ffmpeg** is installed in the api image (voice PoC now; video posters later).
  ⚠️ Stage 3 adds `sharp`/HEIC — install `libvips` in `Dockerfile.api` then and
  re-verify HEIC decode on the VPS (Stage 0 checklist item).
- **Local dev** without Docker: `npm run dev` (Vite :5173 proxies to API :3000).
  You still need a Postgres reachable at `DATABASE_URL` — the simplest is just
  the compose `postgres` service: `docker compose -f deploy/docker-compose.yml up -d postgres`.
  Add MinIO too (`--profile dev up -d postgres minio`) if you're testing media
  upload against the local S3 stand-in rather than real R2.
- **Port collisions on a shared host**: `api`'s host-published port defaults to
  `3000` (only needed for a host-side `npm run dev` to reach the containerized
  API — not required for a pure prod deploy) — override `API_HOST_PORT` in
  `.env` if something else on the box already owns 3000. Same pattern already
  exists for Postgres via `POSTGRES_HOST_PORT`.

## Backups — `deploy/backup.sh`

Nightly `pg_dump` to R2, with a **bounded** retention count so backups can't
quietly accumulate storage forever.

Everything runs through the containers that already exist: the dump comes from
the `postgres` image (which ships `pg_dump`/`pg_restore`) and the upload runs
inside the `api` image (which already holds the R2 credentials and SDK). No
extra tooling on the host (unless you opt into encryption, which needs
`age`), and the R2 keys are never copied anywhere new.

```bash
bash deploy/backup.sh                  # dump -> validate -> upload -> prune
BACKUP_KEEP=14 bash deploy/backup.sh   # override retention for one run

# inspect what's stored
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T api node server/dist/scripts/backup.js list
```

**Retention: `BACKUP_KEEP`, default 7.** Objects live under the `backups/`
prefix, keyed `backups/den-<UTC timestamp>.dump`. After each upload the
uploader lists that prefix and deletes everything past the newest N, so the
count is clamped by construction rather than by a cleanup job that might not
run. Dumps of a closed-circle chat DB are small — media lives in R2 as
objects, not in Postgres — so 7 is comfortably inside the R2 free tier.

**The dump is validated before it's stored.** Size check, then
`pg_restore --list` (parses the archive's table of contents, read-only, never
touches the live DB). A silently truncated backup is worse than none: it looks
like protection while restoring nothing.

### Scheduling (systemd)

```bash
sudo cp deploy/systemd/den-backup* /etc/systemd/system/   # note: den-backup*, picks up the alert unit too
sudo systemctl daemon-reload
sudo systemctl enable --now den-backup.timer

systemctl list-timers den-backup.timer      # confirm next run
sudo systemctl start den-backup.service     # run once, now
journalctl -u den-backup.service -n 50      # read the result
```

`Persistent=true` on the timer means a backup missed while the host was off
runs at next boot rather than being skipped — precisely the situation where
you'd want one.

### Failure alerts (opt-in)

`den-backup.service` has `OnFailure=den-backup-alert.service`, which runs
`deploy/alert.sh`. With nothing configured it logs one line and does nothing.
To get told when a nightly backup fails, add one or both to
`/opt/apps/den/secrets/.env`:

```bash
DEN_ALERT_URL=https://ntfy.sh/<long-random-private-topic>   # plain-text POST; needs curl on the host
DEN_ALERT_CMD=/usr/local/bin/notify-me                      # any command; alert text on stdin + $DEN_ALERT_MESSAGE
```

`DEN_ALERT_URL` suits anything that takes a plain-text body: ntfy, or a
healthchecks.io `/fail` URL. Use `DEN_ALERT_CMD` for services that need their
own payload format, such as Discord or Slack JSON. The message includes the
unit's last 15 journal lines. Test the path without breaking anything:
`sudo systemctl start den-backup-alert.service`, then check your phone and
`journalctl -u den-backup-alert.service`.

Failed **deploys** don't go through this. They're failed GitHub Actions runs,
and GitHub emails those to whoever pushed.

### Encrypting the dump (opt-in)

By default the nightly dump goes to R2 as plaintext, in the same bucket and
under the same credentials as the media. Set a recipient and it's encrypted
with [`age`](https://age-encryption.org) on the host before upload. The
**private key never touches the server**, so a leaked R2 credential, or the
server itself, can't read the stored backups.

```bash
# on YOUR machine (not the server), once:
age-keygen -o den-backup.key          # keep this safe and offline, ideally in 2 places
# it prints "Public key: age1...". On the server:
sudo apt install age                  # ⚠️ REQUIRED on the host once this is set
echo 'BACKUP_AGE_RECIPIENT=age1...' | sudo tee -a /opt/apps/den/secrets/.env
sudo systemctl start den-backup.service && journalctl -u den-backup.service -n 20
```

- `pg_restore --list` validation still runs on the **plaintext** before
  encrypting. After encrypting, the script checks that the output is an age
  file. A real decrypt round trip isn't possible on the host, because the key
  isn't there.
- If `BACKUP_AGE_RECIPIENT` is set but `age` is missing, the backup **fails**
  (and alerts) rather than quietly uploading plaintext.
- Objects keep the `backups/den-<stamp>.dump` name. An encrypted one starts
  with the line `age-encryption.org/v1`. Older dumps stay plaintext until
  retention rotates them out (7 days).
- **Lose the key and you lose every encrypted backup.** Test a restore (below)
  right after turning this on.
- Pre-migration dumps (`--local`) are not encrypted: they sit on the same disk
  as the live database files.

### Restoring (test this before you need it)

A backup nobody has ever restored is a hypothesis, not a backup. Verify into a
**throwaway** database — never straight over the live one:

```bash
C="docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml"

# 1. pick a key and copy it out of R2 through the api container (which holds
#    the credentials). (Untested until the first restore drill — it's part
#    of the drill.)
$C exec -T api node server/dist/scripts/backup.js list
KEY=backups/den-PASTE-THE-STAMP.dump  # the real key from `list`
umask 077                              # the file holds every message + password hash
$C exec -T -e KEY="$KEY" api node --input-type=module -e \
  'import { getObjectBuffer } from "./server/dist/media/r2.js";
   process.stdout.write(await getObjectBuffer(process.env.KEY));' > den.dump
#    (a pre-migration dump is already a local file in /opt/apps/den/backups/)

# 2. only if encryption is on: decrypt, on a machine that has the key
head -c 21 den.dump; echo              # "age-encryption.org/v1" = encrypted, binary noise = plaintext
age -d -i den-backup.key -o den.plain.dump den.dump && mv den.plain.dump den.dump

# 3. restore into a scratch database
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres createdb -U den den_restore_test
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres pg_restore -U den -d den_restore_test < den.dump
# sanity check, then drop it
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres psql -U den -d den_restore_test -c \
  "SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM messages) messages;"
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres dropdb -U den den_restore_test
rm -f den.dump
```

⚠️ **A dump contains everything**: message bodies, argon2 password hashes,
session rows, invite codes. It also shares the private media bucket, so one
leaked R2 credential exposes both, unless encryption (above) is on, in which
case the credential exposes only the media. If the circle ever widens, also
move backups to their own bucket with a separately scoped token.

### ⚠️ Media has no second copy

The nightly job backs up **Postgres only**. The photos, videos, voice notes
and embed snapshots under `media/` and `embeds/` in R2 are the bulk of the
irreplaceable data, and **exactly one copy exists**: in that bucket, behind
one set of credentials. A leaked key (it's on the server and in the api
container), a bad script, or losing the Cloudflare account would lose all of
it. A DB restore would then bring back messages pointing at objects that no
longer exist. No fix is built yet; this is the owner's call. Options:

| Option | Protects against | Cost / catch |
|---|---|---|
| **R2 bucket lock rules** (retention lock on `media/`, set in the Cloudflare dashboard) and, if your account has it, object versioning | A leaked key or a bug deleting or overwriting objects | No new infra and no code. ⚠️ Check what R2 offers today. S3-style versioning wasn't generally available on R2 last time this was checked, but bucket locks were. Doesn't help if the account itself is lost. Locked objects can't be deleted for the lock period, which matters if per-user deletion is ever built. |
| **Second R2 bucket**, synced nightly (`rclone copy`, **never** `sync`, so deletes don't propagate) with a token scoped to that bucket only | Deletes in the main bucket, and a leaked main-bucket key | Cheap: R2 has no egress fees, and storage is the only cost. Same account and provider, so it doesn't cover account loss. R2 tokens have no true "write-only" scope (object read & write is the narrowest that can upload), so keep the backup token **off the api container**, in a host-only job. |
| **Different provider** (Backblaze B2, Hetzner Storage Box, S3, ...), nightly `rclone copy`, optionally through `rclone crypt` | All of the above, plus losing the Cloudflare account | A few $/month at this scale. One more credential, on the host only. Add an `age`/`rclone crypt` layer if the provider shouldn't see the media. This is the real off-site copy. |
| **Local disk / NAS** at the home server, `rclone copy` | Provider- and account-level loss | Nearly free and fast to restore. Shares a location with the DB host, so fire, theft or a dead disk takes both. Only worth it combined with one of the above. |

Whatever you pick: media objects are immutable and keyed by id, so `copy`
(add-only) yields a superset that any DB dump can restore against. Run the
job from the host with its **own** credentials, not the api's. Give it the
same opt-in `OnFailure=` alert as the DB backup, and include a media restore
in the restore drill. A reasonable default is the third row (another provider
via `rclone copy`), plus an R2 bucket lock on `media/` if it's available.

⚠️ If the §7 orphan-sweep job is ever built ("delete R2 objects whose media
row is missing"), it **must** scope itself to the `media/` prefix or it will
cheerfully delete every backup.

## HTTP headers (`deploy/Caddyfile`)

Set by Caddy on every response: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, `X-Frame-Options: DENY` plus
`Content-Security-Policy: frame-ancestors 'none'`, and
`Strict-Transport-Security: max-age=31536000`. HSTS deliberately has **no**
`includeSubDomains` and no `preload`, because sibling `*.ems-place.com`
subdomains host other apps.

Nothing upstream is documented as setting any of these: not the VPS reverse
proxy, Cloudflare, or Fastify. If you ever enable HSTS or security headers on
the VPS proxy or in Cloudflare, remove them from one side. Duplicate HSTS is
harmless, since browsers honour the first, but two sources drift. Check what
actually arrives: `curl -sI https://den.ems-place.com/ | grep -iE 'strict|frame|nosniff|referrer|content-security'`.
To back HSTS out, ship `max-age=0` and keep it up for a year.

Caching (unchanged in intent): `/assets/*` (Vite's hashed files) is
`immutable` for 1 year, and everything else (`index.html`, `sw.js`, the
manifest, icons, SPA routes) is `no-cache`. A **missing** `/assets/*` file is
now a real `404` with `no-store`. It used to fall through to `index.html` and
could get the one-year immutable header. App routes still fall back to
`index.html`.

### Content-Security-Policy — proposed follow-up (NOT deployed)

A full policy would meaningfully harden the app against XSS. But a wrong one
silently breaks media, GIFs, embeds, the Vault portal or the service worker,
so it ships only after the test plan below. A starting point (replace
`<account>` with the R2 account id from `R2_ENDPOINT`):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data: https://<account>.r2.cloudflarestorage.com https://*.klipy.com https://*.klipy.co;
media-src 'self' blob: https://<account>.r2.cloudflarestorage.com;
connect-src 'self' wss://den.ems-place.com https://<account>.r2.cloudflarestorage.com;
frame-src https://vault.ems-place.com;
worker-src 'self';
manifest-src 'self';
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

Why each non-`'self'` entry exists, so you can verify it instead of trusting
it:

- **R2**: presigned GETs (images, video, voice, embed snapshots, sent GIFs)
  go into `img-src`/`media-src`, and presigned **PUT** uploads go into
  `connect-src`. Path-style (`R2_FORCE_PATH_STYLE=true`) means one host. Check
  a real presigned URL from `/api/media/:id/url` for the exact host.
- **Klipy**: picker thumbnails load straight from Klipy's CDN (docs/GIFS.md
  D10). Confirm the actual CDN hostnames in devtools; the server's own
  allowlist is `.klipy.com` / `.klipy.co`.
- **`frame-src` Vault**: the Stage portal iframe (docs/EMBEDS.md §6.5).
- **`blob:`/`data:`**: local previews of camera captures and attachments
  before upload, and the voice recorder.
- **`'unsafe-inline'` in `style-src`**: React `style={…}` attributes.
  index.html has no inline `<script>` (the SW is registered from `main.tsx`;
  `injectRegister: null`), so `script-src` can stay strict.
- **`wss://`** is listed explicitly because older Safari versions don't match
  `'self'` against websocket URLs.
- **`form-action 'self'`**: check that the Vault OAuth link flow isn't a form
  POST that redirects cross-origin. Chrome applies `form-action` to the
  redirect.

Test plan:

1. Ship it as **`Content-Security-Policy-Report-Only`** (a second header, so
   the enforcing `frame-ancestors` one stays).
2. On **installed iOS PWA**, Android Chrome PWA and desktop, with the devtools
   console open (Safari Web Inspector for iOS), go through: sign-in, open
   chats, send text, send image, video and voice, and play them back; open
   the gallery and the viewer; search the GIF picker and send a GIF; paste an
   Instagram link; open a Vault Stage document and edit; use the in-app
   camera (photo and hold-to-record); enable push and receive one; force a
   SW update (deploy, then the reload prompt); reload while offline.
3. Every `Refused to …` / report-only violation is either a missing source,
   to add with a reason, or a bug. Repeat until clean on all three platforms.
4. Switch the header to enforcing by merging it into the existing CSP line in
   the Caddyfile. Keep the Report-Only copy for one more deploy, then drop
   it.

## CI/CD — self-hosted runner (push-to-deploy)

Topology: Cloudflare/DNS → **FRP** on the VPS tunnels public 80/443 to Caddy on
the **home server** (pure networking, nothing to do with CI). A **GitHub
Actions self-hosted runner** installed on the home server polls GitHub over
an outbound connection and runs `.github/workflows/deploy.yml` locally on
every push to `main` — no inbound port needed for CI, no SSH deploy step.

### One-time setup on the home server

1. **Prereqs**: Docker + Docker Compose plugin installed, this repo cloned
   somewhere permanent (e.g. `/opt/apps/den/repo`), and a real `.env` filled
   in from `deploy/.env.prod.example` — but keep it **outside the repo
   checkout**, at `/opt/apps/den/secrets/.env`. This matters: the runner
   re-checks-out the repo on every run, and an `.env` living inside the
   checkout risks being wiped by git's clean step. The workflow reads it via
   `--env-file` at that fixed path (the default in the workflow — override
   with a repo variable `DEN_ENV_FILE` under Settings → Secrets and
   variables → Actions → Variables if you put it somewhere else).

   ⚠️ **`DEN_DATA_ROOT` is required in that `.env`.** The runner does *not*
   deploy from `/opt/apps/den/repo` — `actions/checkout` puts the code in the
   runner's own workspace (`/opt/actions-runner/den/_work/den/den`), so the
   host has **two** checkouts of this repo. Compose resolves relative bind
   mounts against the compose file's directory, and `name: den` pins both
   checkouts to the same project — so without `DEN_DATA_ROOT`, a runner
   deploy recreates `den-postgres-1` bound to an *empty* `pg-data/` in the
   runner workspace. Prod would look like every user, message and invite had
   vanished (the real data is still fine, at the other path — but new writes
   land in the new DB, so you get a split brain on top).

   Point it at wherever the live data already is, which for a host that has
   been deploying manually from `/opt/apps/den/repo` is:
   ```bash
   # confirm first — this should list a populated Postgres data dir
   sudo ls /opt/apps/den/repo/deploy/pg-data
   # then add to /opt/apps/den/secrets/.env
   DEN_DATA_ROOT=/opt/apps/den/repo/deploy
   ```
   `deploy/deploy.sh`'s preflight refuses to deploy if
   this is unset or its `pg-data/` is missing, so a misconfiguration fails
   loudly instead of quietly starting a fresh database. Relocating the data
   somewhere tidier (e.g. `/opt/apps/den/data`) is a fine idea, but do it as
   a deliberate, stack-stopped step — and not before backups exist.

2. **Register the runner** (repo-scoped): on GitHub, go to this repo →
   **Settings → Actions → Runners → New self-hosted runner**, pick Linux/x64,
   and follow the generated commands on the home server — they look like:
   ```bash
   mkdir actions-runner && cd actions-runner
   curl -o actions-runner.tar.gz -L <url from the GitHub page>
   tar xzf actions-runner.tar.gz
   ./config.sh --url https://github.com/<you>/den --token <one-time token from the GitHub page>
   ```
   The token is single-use and expires quickly — copy it fresh from the page
   each time, don't reuse an old one from memory/notes.

3. **Install it as a persistent service** (so it survives reboots and doesn't
   need a terminal left open):
   ```bash
   sudo ./svc.sh install
   sudo ./svc.sh start
   ```
   Check it's alive: `sudo ./svc.sh status`, and it should also show
   "Idle"/green under the repo's Settings → Actions → Runners page.

4. **Create the pre-migration backup dir** (see "Pre-migration backups"),
   writable by the runner's service user:
   `sudo install -d -m 700 -o <runner-user> /opt/apps/den/backups`. Without
   it, every deploy stops at preflight and nothing is touched.

5. **Push to `main`.** The `verify` job (typecheck, lint, tests) runs first,
   on a GitHub-hosted runner. Only if it passes does `deploy` run
   `deploy/deploy.sh` on this host (see "Deploying to prod" for each step).
   Watch both live under the repo's **Actions** tab.

### The quality gate (`verify` job)

A push to `main` used to deploy immediately, with lint and tests never run.
Now `deploy` has `needs: verify`, and `verify` runs `npm ci` → build `shared`
→ `npm run typecheck` → `npm run lint` → `db:migrate` → `npm run test`.

- **It runs on `ubuntu-latest` (GitHub-hosted), not the self-hosted runner.**
  That keeps two throwaway databases and the test suite off the box serving
  prod, and gives every run a clean machine, so tests can never reach prod's
  Postgres or R2. It costs Actions minutes on a private repo (a few per
  push). If hosted runners are disabled or the minutes run out, `verify`
  never starts and **nothing deploys**.
- The server tests are integration tests, so the job runs a disposable
  Postgres 16 (service container, migrated from empty, which also proves the
  whole migration chain applies from scratch) and a disposable MinIO for the
  one test that PUTs/HEADs a real object.
  `embeds/service.test.ts` expects Instagram to be unreachable, so the job
  points the IG hostnames at localhost. It's a TODO to make that test
  hermetic in code.
- No `pull_request` trigger, on purpose: PR code must never reach the
  self-hosted runner. The gate only needs to guard what actually deploys.
- **Bypass for emergencies**: deploy by hand on the host
  (`bash deploy/deploy.sh`), which never runs the gate. `workflow_dispatch`
  does still run the gate.

### Troubleshooting

**A fix landed on `main` but the deploy fails with the identical error** —
check *which commit* the run is on. GitHub's **"Re-run jobs"** replays the run
at its **original commit**, so it will never pick up anything merged since;
the fix looks broken when it simply wasn't present. Either open the newer run
that the push created, or use **Actions → Deploy → Run workflow**
(`workflow_dispatch`), which always runs the tip of the branch. A quick tell:
if a step you know you added isn't in the log at all, you're looking at an old
commit.

**`error from sender: open .../deploy/pg-data: permission denied`** — the
build context (the repo root) included Postgres's data dir, which is owned by
the container's postgres uid with 0700 perms, so the build-context sender
can't read it. Fixed by the root `.dockerignore`; if you hit it again, check
that file still excludes `deploy/pg-data/`. Note `.gitignore` does **not**
apply to Docker build contexts — the two lists are maintained separately.

### Notes

- This is a single-user/closed-repo setup — self-hosted runners are a real
  security consideration on repos that take PRs from strangers (a workflow
  from an untrusted PR can run arbitrary code on the runner host). The
  workflow has no `pull_request` trigger, so even a PR can't run here. Keep
  it that way, and never add one to a job with `runs-on: self-hosted`.
- To re-register the runner on a fresh machine, repeat step 2 with a new
  token; `./config.sh remove --token <token>` first if replacing an existing
  registration.
- Migrations run on every deploy, including no-op ones — `drizzle-kit
  migrate` is idempotent (skips already-applied migrations), so this is safe
  even when a push doesn't touch the schema. So does the pre-migration dump,
  which takes seconds at this size.
