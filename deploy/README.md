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

What it does, in order: preflight (docker present, env file present,
`DEN_DATA_ROOT` set **and** its `pg-data/` actually existing) → `up -d --build`
→ wait for the `api` container → `db:migrate` → prune → print status. Every
preflight check runs before anything touches a container, so a misconfigured
host fails loudly and changes nothing.

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
- **Migrations**: run inside the api container once the domain schema exists —
  `docker compose exec api npm -w server run db:migrate`.
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
extra tooling on the host, and the R2 keys are never copied anywhere new.

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
sudo cp deploy/systemd/den-backup.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now den-backup.timer

systemctl list-timers den-backup.timer      # confirm next run
sudo systemctl start den-backup.service     # run once, now
journalctl -u den-backup.service -n 50      # read the result
```

`Persistent=true` on the timer means a backup missed while the host was off
runs at next boot rather than being skipped — precisely the situation where
you'd want one.

### Restoring (test this before you need it)

A backup nobody has ever restored is a hypothesis, not a backup. Verify into a
**throwaway** database — never straight over the live one:

```bash
# copy a dump out of R2 (via the api container), then:
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres createdb -U den den_restore_test
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres pg_restore -U den -d den_restore_test < den-<stamp>.dump
# sanity check, then drop it
docker compose --env-file /opt/apps/den/secrets/.env -f deploy/docker-compose.yml \
  exec -T postgres psql -U den -d den_restore_test -c \
  "SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM messages) messages;"
```

⚠️ **A dump contains everything** — message bodies, argon2 password hashes,
session rows, invite codes — and shares the private media bucket. One leaked
R2 credential exposes both. Fine for a closed circle; if that changes, move
backups to their own bucket with a separately scoped token.

⚠️ If the §7 orphan-sweep job is ever built ("delete R2 objects whose media
row is missing"), it **must** scope itself to the `media/` prefix or it will
cheerfully delete every backup.

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
   The workflow's "Guard persistent data paths" step refuses to deploy if
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

4. **Push to `main`** — the workflow checks out the repo, guards the data
   paths (see step 1), runs `docker compose up -d --build`, runs migrations
   inside the `api` container, and prunes old images. Watch it live under the
   repo's **Actions** tab.

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
  from an untrusted PR can run arbitrary code on the runner host), but that
  doesn't apply here.
- To re-register the runner on a fresh machine, repeat step 2 with a new
  token; `./config.sh remove --token <token>` first if replacing an existing
  registration.
- Migrations run on every deploy, including no-op ones — `drizzle-kit
  migrate` is idempotent (skips already-applied migrations), so this is safe
  even when a push doesn't touch the schema.
