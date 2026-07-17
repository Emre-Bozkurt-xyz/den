# Stage 0 — Risk Retirement: status & handoff

_Last updated: 2026-07-17_

Stage 0 exists to retire the project's external risks before any product code is
written (BACKBONE §14). This tracks what's built, what's verified on this dev
machine, and what **you** must still verify on real hardware (the iPhone and the
VPS) before Stage 0 can be called done.

## What's built (all typecheck + lint + build clean)

Monorepo scaffold with npm workspaces:

- **`/shared`** — the LOCKED `WsEnvelope`, reserved `call.*` prefix guard, and the
  first API DTOs (`ApiError`, `ErrorCode`, `MeResponse`, push shapes).
- **`/server`** — Fastify 5 + socket.io, the `{error:{code,message}}` error
  envelope, `/health` (DB-reachability probe), Drizzle wired to Postgres.
  Domain schema is intentionally **empty** — migration 001 is Stage 1.
- **`/app`** — Vite 6 + React 19 + Tailwind v4 PWA. `vite-plugin-pwa`
  (injectManifest) with a custom service worker (`src/sw.ts`) carrying push +
  notificationclick handlers. Manifest, icons, dark mode, `100dvh`, safe-area
  insets, iOS install-instructions screen.
- **`/deploy`** — Docker Compose (postgres + api + caddy), Caddyfile for
  `den.ems-place.com` (same-origin app + API + WSS), two Dockerfiles.
- **Push PoC** — `POST /api/push/{config,subscribe,test}` (in-memory subs,
  throwaway) + an "Enable notifications" button that fires the permission prompt
  from a user gesture (iOS requirement).
- **Voice PoC** — record → upload → server ffmpeg → **AAC/m4a** → playback.

## Verified locally (this Windows dev box)

- ✅ `npm run typecheck` / `npm run lint` / `npm run build` all pass.
- ✅ Server boots; `/health` returns 503 when DB is down (correct), the error
  envelope is exactly `{error:{code,message}}`.
- ✅ `/api/push/config` serves the VAPID public key.
- ✅ **Voice transcode round-trips**: WAV → `POST /voice-poc/upload` → 48 kHz mono
  AAC/m4a → `GET /voice-poc/:id` returns `audio/mp4`. Worked even on this box's
  ancient bundled ffmpeg (see gotcha below).
- ✅ App builds a valid service worker (`sw.js`) + `manifest.webmanifest` +
  precache.

### ffmpeg gotchas found & fixed
This machine's `ffmpeg` on PATH is an ancient 2013 Panda3D bundle (libavcodec 55).
Two things it taught us, now baked into the transcode command:
- `-hide_banner` is unrecognized on old builds → **removed**.
- AAC at 96k needs a sane sample rate or it errors "too many bits per frame" →
  we now force **`-ar 48000`** (also correct one-format normalization anyway).

The Docker api image installs a **modern** ffmpeg, so production is unaffected —
but if you run `npm run dev` directly on a machine with an old ffmpeg, put a
current build earlier on PATH.

## ⛔ Not done — needs real hardware (these are the actual Stage 0 gates)

1. **Push GO/NO-GO on a real iPhone** (installed PWA, iOS ≥ 16.4). This is the
   project's biggest external risk. Steps below. Android/desktop is the easy
   case and does **not** count as validating this.
2. **Voice record on iOS Safari** — confirm MediaRecorder output there
   transcodes and the returned m4a plays. (Local transcode is proven; the iOS
   *record* + *playback* path is not.)
3. **VPS check**: modern `ffmpeg` present, and `sharp` + **HEIC decode**
   (libheif/libvips) working — needed for Stage 3 but verified now per §14.

## How to run

```bash
cp .env.example .env
npm run vapid:gen                 # paste keys into .env
# Postgres for /health (Docker Desktop must be running):
docker compose --env-file .env -f deploy/docker-compose.yml up -d postgres
npm run dev                       # app :5173 (proxies API :3000)
```

### iPhone push test (the gate)
1. Deploy the stack to `den.ems-place.com` (real TLS) — Web Push needs HTTPS and,
   on iOS, an **installed** PWA. `localhost` won't exercise the iOS path.
2. On the iPhone: open in Safari → Share → **Add to Home Screen** → open from the
   Home Screen icon.
3. Tap **Enable notifications**, accept the prompt.
4. Background the app. Tap **Send test** (from another device, or re-open briefly).
5. ✅ GO if the notification appears on the lock screen and tapping it opens Den.
   ❌ NO-GO → this is the biggest risk; debug before building Stage 1 (use a
   remote-logging shim / `eruda` since you can't devtools iOS without a Mac).

## Notes for later stages
- `push_subscriptions` currently lives in memory (PoC). Stage 2 moves it to
  Postgres with membership-scoped fanout and 404/410 pruning.
- The voice PoC uploads bytes *through the API* — a deliberate PoC shortcut. The
  real pipeline (Stage 3) is client ⇄ R2 presigned only (hard invariant 2).
- `Dockerfile.api` gets `libvips` added in Stage 3 for sharp/HEIC.
