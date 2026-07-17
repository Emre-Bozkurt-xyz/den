# CLAUDE.md

Private, self-hosted chat + media app (PWA) for a closed friend circle. Invite-only, owner-hosted (VPS + Postgres + Cloudflare R2), $0 to Apple — iOS is served via installed PWA.

## The prime directive

**`docs/BACKBONE.md` is the source of truth.** Read the relevant section before designing or implementing anything non-trivial. If a request conflicts with BACKBONE.md, say so and ask — don't silently diverge. If a decision is made or changed during a session, append it to §15 (Decision Log) as part of the same change.

Quick section map: §2 MVP scope table · §3 stack · §5 schema + tag rules + gallery query · §6 API + auth invariants · §7 media pipeline · §8 WS/push · §9 UI/PWA checklist · §11 call-readiness invariants · §13 Icebox · §14 build order.

## Scope rules (non-negotiable)

- If a feature is not in the BACKBONE §2 MVP table, **do not build it**. Add the idea to §13 (Icebox) instead.
- Stages (§14) ship in order. Don't start Stage N+1 work inside a Stage N task.
- MVP auth = invite code + password only. `auth_identities` and `webauthn_credentials` exist in the schema but **nothing writes to them** — do not implement OAuth or passkeys yet. Don't repurpose the reserved `/auth/oauth/*` and `/auth/passkey/*` route paths.
- No call code. Preserve the §11 invariants: DMs stay 2-member groups (`is_group=false`), never special-case DMs, and the `call.signal.*` / `call.state.*` WS type prefixes stay reserved.

## Repo layout

```
/app        — Vite + React 19 + TS PWA (Tailwind, TanStack Query, socket.io-client)
/server     — Fastify + TS (REST + socket.io, Drizzle, media workers: sharp/ffmpeg)
/shared     — types shared by both: WS envelope, API DTOs. Import from here, never duplicate.
/deploy     — docker-compose.yml, Caddy config, migration runner
docs/BACKBONE.md — design source of truth
```

All API/WS payload types live in `/shared` and are imported by both sides. If you find yourself redefining a shape in `/app` or `/server`, stop and move it to `/shared`.

## Commands

<!-- Update these as the repo takes shape; keep them runnable. -->
- `npm run dev` — app + server concurrently (Vite on 5173, API on 3000)
- `npm run db:migrate` / `npm run db:generate` — Drizzle migrations (never edit applied migrations; add new ones)
- `npm run typecheck` / `npm run lint` / `npm run test` — must pass before a task is "done"
- `docker compose -f deploy/docker-compose.yml up -d` — full stack locally

## Hard invariants (violating these is a bug, not a style choice)

1. **Authorization = chat membership.** Every chat-scoped REST route and WS subscription calls `assertMember(userId, chatId)`. No exceptions, no "it's only reachable from the UI" reasoning. This is the app's entire privacy model.
2. **Media bytes never transit the API server.** Client ⇄ R2 via presigned URLs only; server mints URLs and records metadata. Bucket stays private; presigned GETs are short-lived.
3. **Server is the truth, client is a cache.** iOS evicts PWA storage; nothing may exist only client-side. On WS reconnect, refetch — never replay missed frames.
4. **All WS traffic uses the `WsEnvelope` from `/shared`** (`{type, payload, ts, reqId?}`). New features add `type` values; never invent a second envelope or side-channel.
5. **Tag normalization** (BACKBONE §5): trim → lowercase → spaces→hyphens → charset `[a-z0-9_-]`, ≤64 chars, unique per `(chat_id, name)`. Tags are per-chat, shared-wiki permissions (any member adds/removes any tag), `tagged_by` = attribution only. Normalization is hinted in the UI, never silent.
6. **EXIF (incl. GPS) is stripped** from images during processing. Voice is transcoded server-side to m4a/AAC — one storage format, no playback-time format detection.
7. **Never trust client-declared mime/size.** Verify after upload-complete (HEAD + sniff) before marking media `ready`.
8. **Soft deletes only** (`deleted_at`); queries must filter them.
9. **Sessions**: httpOnly + Secure + SameSite=Lax cookie backed by the `sessions` table. Passwords: argon2id. Auth routes are rate-limited. No JWTs.
10. **No third-party JS, CDNs, fonts, or analytics** in the client. Self-host everything.

## Platform reality (read before touching UI, media, or push)

- **Dev device is Android (Samsung); most users are on iPhone.** iOS quirks are load-bearing even though we don't dev on iOS. Flag anything you write that is likely to behave differently on iOS Safari / installed PWA (MediaRecorder formats, audio autoplay, `100dvh`, safe areas, push permission gestures) so it lands on the iOS-testing checklist for the stage gate.
- Layout: `100dvh` not `100vh`; `env(safe-area-inset-*)` on tab bar/headers; `touch-action: manipulation` on controls; dark mode via Tailwind `dark:` from the start.
- Push: web-push + VAPID; iOS requires installed PWA + user-gesture permission prompt; delete subscription rows on 404/410.
- Voice: expect `audio/mp4` from iOS Safari and `audio/webm;codecs=opus` from Chrome — both are valid inputs; ffmpeg normalizes.

## Conventions

- TypeScript strict everywhere; no `any` without a comment justifying it.
- Drizzle for all DB access; raw SQL allowed only for the gallery tag query (§5 reference impl) and similar hot queries — keep them in one `queries/` module with the SQL visible.
- Keyset pagination (`before` cursor on `id`) for messages and gallery — no OFFSET in new code.
- Errors: Fastify error handler returns `{error: {code, message}}`; client maps codes, never string-matches messages.
- Commits: conventional-ish (`feat:`, `fix:`, `chore:`), one logical change per commit.
- When adding a migration, update the schema section reference in BACKBONE §5 if the shape diverges.

## When unsure

Prefer asking over assuming for: anything touching auth, anything that widens data visibility across chats, anything that adds a dependency, and anything not clearly inside the current stage. For pure implementation detail inside agreed scope — just build it well.