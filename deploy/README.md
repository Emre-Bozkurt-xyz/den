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

Caddy will obtain TLS automatically once `den.ems-place.com` points at the host
and ports 80/443 are reachable.

## Notes

- **Postgres** is not published to the host; only the `api` service reaches it
  over the compose network. Data persists in `deploy/pg-data/` (gitignored).
- **Migrations** (Stage 1 onward): run inside the api container once the domain
  schema exists — `docker compose exec api npm -w server run db:migrate`.
  Stage 0 has no domain schema yet, so there is nothing to migrate.
- **ffmpeg** is installed in the api image (voice PoC now; video posters later).
  ⚠️ Stage 3 adds `sharp`/HEIC — install `libvips` in `Dockerfile.api` then and
  re-verify HEIC decode on the VPS (Stage 0 checklist item).
- **Local dev** without Docker: `npm run dev` (Vite :5173 proxies to API :3000).
  You still need a Postgres reachable at `DATABASE_URL` — the simplest is just
  the compose `postgres` service: `docker compose -f deploy/docker-compose.yml up -d postgres`.

## CI/CD — self-hosted runner (push-to-deploy)

Topology: Cloudflare/DNS → **FRP** on the VPS tunnels public 80/443 to Caddy on
the **home server** (pure networking, nothing to do with CI). A **GitHub
Actions self-hosted runner** installed on the home server polls GitHub over
an outbound connection and runs `.github/workflows/deploy.yml` locally on
every push to `main` — no inbound port needed for CI, no SSH deploy step.

### One-time setup on the home server

1. **Prereqs**: Docker + Docker Compose plugin installed, this repo cloned
   somewhere permanent (e.g. `/opt/den`), and a real `.env` filled in per
   "First run" above — but keep it **outside the repo checkout**, e.g.
   `/opt/den-secrets/.env`. This matters: the runner re-checks-out the repo on
   every run, and an `.env` living inside the checkout risks being wiped by
   git's clean step. The workflow reads it via `--env-file` at that fixed
   path (default `/opt/den/.env` in the workflow — override with a repo
   variable `DEN_ENV_FILE` under Settings → Secrets and variables → Actions →
   Variables if you put it somewhere else).

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
