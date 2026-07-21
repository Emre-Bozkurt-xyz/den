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

4. **Push to `main`** — the workflow checks out the repo, runs
   `docker compose up -d --build`, runs migrations inside the `api`
   container, and prunes old images. Watch it live under the repo's
   **Actions** tab.

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
