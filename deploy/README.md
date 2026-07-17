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
