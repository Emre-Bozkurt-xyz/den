# CLAUDE.md

Private, self-hosted chat + media app (PWA) for a closed friend circle. Invite-only, owner-hosted (VPS + Postgres + Cloudflare R2), $0 to Apple — iOS is served via installed PWA. **The MVP is complete and verified on real devices; the project is in post-MVP feature work.**

## The prime directive

**`docs/PROJECT.md` is the living source of truth.** Read the relevant section before designing or implementing anything non-trivial. If a request conflicts with it, say so and ask — don't silently diverge. If a decision is made or changed during a session, append it to PROJECT.md §14 (Decision Log) as part of the same change.

Quick section map: §4 repo map · §5 data model · §6 API surface · §7 WS protocol · §8 media pipeline · §11 frontend architecture · §12 platform/iOS reality · §13 roadmap + icebox · §15 call invariants · §16 workflow.

The MVP-era design history (full rationale, stage-by-stage verification notes, ~60 decision-log entries) lives in **`docs/archive/`** — `BACKBONE.md` above all. Consult it before re-litigating anything that looks odd; most oddities are documented decisions. Don't edit archived docs except to fix a broken pointer. Code comments citing "BACKBONE §N" refer to `docs/archive/BACKBONE.md` and stay valid — leave them; new code cites PROJECT.md.

## Scope rules (non-negotiable)

- **Feature work follows the roadmap** (PROJECT.md §13). New feature ideas outside it go to the Icebox section, or get an explicit owner decision (logged in §14) to pull them forward. Non-trivial features get a short plan doc in `docs/` first (pattern: `docs/MESSAGE_SEARCH.md`).
- Auth is still invite code + password only. `auth_identities` and `webauthn_credentials` exist in the schema but **nothing writes to them** — do not implement OAuth or passkeys until their roadmap slot arrives. Don't repurpose the reserved `/auth/oauth/*` and `/auth/passkey/*` route paths.
- No call code. Preserve the call-readiness invariants (PROJECT.md §15): DMs stay 2-member groups (`is_group=false`), never special-case DMs, and the `call.signal.*` / `call.state.*` WS type prefixes stay reserved.

## Repo layout

```
/app        — Vite + React 19 + TS PWA (Tailwind, TanStack Query, socket.io-client)
/server     — Fastify + TS (REST + socket.io, Drizzle, media processing: sharp/ffmpeg)
/shared     — types shared by both: WS envelope, API DTOs, tag normalization. Import from here, never duplicate.
/deploy     — docker-compose.yml, Caddy config, Dockerfiles, backups
docs/PROJECT.md — living source of truth (file-level repo map in its §4)
docs/archive/   — MVP-era design docs, read-only history
```

All API/WS payload types live in `/shared` and are imported by both sides. If you find yourself redefining a shape in `/app` or `/server`, stop and move it to `/shared`.

## Commands

- `npm run dev` — app + server concurrently (Vite on 5173, API on 3000)
- `npm run db:migrate` / `npm run db:generate` — Drizzle migrations (never edit applied migrations; add new ones)
- `npm run typecheck` / `npm run lint` / `npm run test` — must pass before a task is "done"
- `docker compose -f deploy/docker-compose.yml up -d` — full stack locally (Postgres + API + Caddy + MinIO)
- `npm run invite create` — mint an invite code

## Hard invariants (violating these is a bug, not a style choice)

1. **Authorization = chat membership.** Every chat-scoped REST route and WS subscription calls `assertMember(userId, chatId)`. No exceptions, no "it's only reachable from the UI" reasoning. This is the app's entire privacy model.
2. **Media bytes never transit the API server.** Client ⇄ R2 via presigned URLs only; server mints URLs and records metadata. Bucket stays private; presigned GETs are short-lived.
3. **Server is the truth, client is a cache.** iOS evicts PWA storage; nothing may exist only client-side. On WS reconnect, refetch — never replay missed frames.
4. **All WS traffic uses the `WsEnvelope` from `/shared`** (`{type, payload, ts, reqId?}`). New features add `type` values; never invent a second envelope or side-channel.
5. **Tag normalization** (`shared/src/tags.ts`, one implementation for both sides): trim → lowercase → spaces→hyphens → charset `[a-z0-9_-]`, ≤64 chars, unique per `(chat_id, name)`. Tags are per-chat, shared-wiki permissions (any member adds/removes any tag), `tagged_by` = attribution only. Normalization is hinted in the UI, never silent.
6. **EXIF (incl. GPS) is stripped** from images during processing. Voice is transcoded server-side to m4a/AAC — one storage format, no playback-time format detection.
7. **Never trust client-declared mime/size.** Verify after upload-complete (HEAD + sniff) before marking media `ready`.
8. **Soft deletes only** (`deleted_at`); queries must filter them. Hard-wipe is an iceboxed feature that requires an explicit, logged override — never a side effect.
9. **Sessions**: httpOnly + Secure + SameSite=Lax cookie backed by the `sessions` table. Passwords: argon2id. Auth routes are rate-limited. No JWTs.
10. **No third-party JS, CDNs, fonts, or analytics** in the client. Self-host everything. No animation or gesture libraries — that surface is hand-rolled Pointer Events/CSS by established precedent.

## Platform reality (read before touching UI, media, or push)

- **Dev device is Android (Samsung); most users are on iPhone.** iOS quirks are load-bearing even though we don't dev on iOS. Flag anything you write that is likely to behave differently on iOS Safari / installed PWA (MediaRecorder formats, audio gesture rules, `100dvh`, safe areas, push permission gestures, edge-swipe vs. custom gestures) so it lands on the standing real-device checklist — never silently call it done. PROJECT.md §12 has the full quirk list and what's already hardware-verified.
- Layout: `100dvh` not `100vh`; `env(safe-area-inset-*)` on tab bar/headers; `touch-action: manipulation` on controls; dark mode via the design tokens in `app/src/index.css` (never hardcoded colors — see PROJECT.md §11).
- Push: web-push + VAPID; iOS requires installed PWA + user-gesture permission prompt; delete subscription rows on 404/410.
- Voice: expect `audio/mp4` from iOS Safari and `audio/webm;codecs=opus` from Chrome — both are valid inputs; ffmpeg normalizes.

## Conventions

- TypeScript strict everywhere; no `any` without a comment justifying it.
- Drizzle for all DB access; raw SQL allowed only for hot queries like the gallery tag match — keep the SQL visible in its module (`server/src/media/gallery.ts` is the precedent).
- Keyset pagination (`before` cursor on `id`) for messages and gallery — no OFFSET in new code.
- Errors: Fastify error handler returns `{error: {code, message}}`; client maps codes, never string-matches messages.
- Commits: conventional-ish (`feat:`, `fix:`, `chore:`), one logical change per commit.
- When adding a migration, update PROJECT.md §5 if the model rules or table list change.
- Definition of done: typecheck + lint + test green, server behavior verified with a scripted multi-account flow against the compose stack, iOS-divergent UI flagged (PROJECT.md §16).

## When unsure

Prefer asking over assuming for: anything touching auth, anything that widens data visibility across chats, anything that adds a dependency, and anything not clearly on the roadmap or in an agreed plan doc. For pure implementation detail inside agreed scope — just build it well.
