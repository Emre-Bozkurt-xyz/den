# Den — Project Knowledge

**This is the living source of truth.** It replaced `docs/archive/BACKBONE.md` (the MVP-era design doc) on 2026-07-22, when the MVP was declared complete and verified on real iOS. The archive keeps the full design rationale and stage-by-stage history; this file describes **what exists now**, where it lives, and the rules that keep it coherent. If a decision is made or changed, append it to §14 (Decision Log) in the same change.

## 1. What Den is

Private, self-hosted chat + media app (PWA) for a closed friend circle. Invite-only, owner-hosted (VPS + Postgres + Cloudflare R2), $0 to Apple — iOS is served via installed PWA at **`den.ems-place.com`** (domain locked forever: future passkeys bind to it as rpID).

**Shipped:** auth (invite + password), friending, DMs + group chats, realtime text over WS, media messages (image/video/voice) with presigned R2 upload + server-side processing, per-chat gallery (masonry grid + voice archive) with booru-style tag search and batch tagging, web push (incl. iOS installed PWA — verified on hardware), message soft-delete with undo + multi-select, message replies + reactions, full PWA polish pass (design tokens, dark mode, back-gesture bridge, safe areas), nightly `pg_dump` → R2 backups.

**Deliberate non-goals:** public discovery, user search beyond friends, moderation/reporting/blocking, E2EE in v1 (honest model: owner can technically read the DB; E2EE is roadmap).

## 2. Stack

| Layer | Choice | Load-bearing notes |
|---|---|---|
| Frontend | Vite + React 19 + TS, Tailwind v4 | No router — hand-rolled view stack in `App.tsx`. Design tokens in `app/src/index.css` `@theme`. Icons: `lucide-react` (bundled, no CDN). |
| Server state | TanStack Query + thin WS layer writing into the Query cache | `app/src/lib/realtime.tsx` is that layer. |
| Backend | Node + Fastify 5 + TS | REST + socket.io on one process; media processing inline (no queue — deliberate, see archive §15 2026-07-20). |
| DB | Postgres + Drizzle | `server/src/db/schema.ts` is the schema source of truth. Migrations in `server/drizzle/` (6 so far). |
| Media storage | Cloudflare R2 (prod) / MinIO (dev compose) | Same S3 client code; swap is env-only. Bucket private, presigned URLs only. |
| Realtime | socket.io (rooms, reconnect) | Cookie-authed handshake. |
| Push | `web-push` + VAPID | iOS ≥16.4 installed-PWA only; gesture-gated permission prompt. |
| Auth | Session cookie (httpOnly/Secure/SameSite=Lax) + `sessions` table; argon2id via `@node-rs/argon2` | No JWTs. `Secure` is prod-only (dev is http). |
| Deploy | Docker Compose (postgres, api, caddy, minio-in-dev) + Caddy TLS | `deploy/`. Static assets: `/assets/*` immutable 1y, else `no-cache` (Caddyfile) — deploys must stay visible to installed PWAs. |

## 3. Architecture

```
[iOS PWA] [Android PWA] [Desktop browser]
      │ HTTPS (REST + presigned R2 URLs)   │ WSS (socket.io)
      ▼                                    ▼
[Caddy] ──► [Fastify API + socket.io] ──► [Postgres]
                 │        └──► [web-push → APNs/FCM]
                 ▼ (inline, post-upload-complete)
          [sharp / ffmpeg] ──► [R2 / MinIO]
```

Core flows:
- **Text:** client → WS `message.send` → persist → fanout to `chat:{id}` room → push to members with no live socket in that room.
- **Media:** `POST /media/uploads` (mints presigned PUT + creates the message row) → client PUTs bytes straight to R2 → `POST /media/:id/complete` → server HEAD-verifies + magic-number sniffs → fans out `message.new` (status `processing`) → inline processing → `media.ready`. **Media bytes never transit the API server.**
- **View media:** short-lived presigned GETs minted per request (`GET /media/:id/url`).
- **Reconnect:** client refetches via Query invalidation. Never replay missed WS frames — DB is truth, WS is a hint.

## 4. Repo map (where to dig)

```
/shared/src
  api.ts        — every REST DTO + limits (ChatLimits, MediaLimits, ReactionLimits…)
  ws.ts         — WsEnvelope, WsType registry, payload types, reserved-prefix guard
  tags.ts       — tag normalization + booru query parser (client AND server import this)

/server/src
  app.ts, server.ts, ws.ts   — Fastify wiring, socket.io handshake/rooms, WS message.send path
  env.ts, env-file.ts        — typed env loading
  errors.ts                  — {error:{code,message}} envelope + helpers (validation(), forbidden()…)
  mappers.ts                 — DB row → DTO mapping
  auth/                      — session create/verify (requireAuth preHandler), argon2, rate limits
  chat/
    membership.ts            — assertMember (THE authorization primitive)
    service.ts               — chat list/create, message pages, markRead, soft delete/restore
    friends.ts, replies.ts, reactions.ts
  media/
    service.ts               — createUpload/completeUpload, validation ceilings + sniffing
    process.ts, ffmpeg.ts    — sharp (EXIF strip, WebP + 400px thumb), ffmpeg (poster, m4a transcode)
    r2.ts                    — S3 clients: operational + signing-only (public endpoint; SigV4 signs Host)
    gallery.ts               — gallery query (raw SQL for tag matching lives here, documented)
    tags.ts                  — tag registry, usage counts, add/remove
  realtime/rooms.ts          — chatRoom()/userRoom() naming
  push/                      — web-push send, 404/410 subscription pruning
  routes/                    — auth, chats, friends, gallery, media, push, health (+ voice-poc, legacy)
  scripts/                   — invite CLI, backup.ts
  db/schema.ts               — Drizzle schema (source of truth for the data model)

/app/src
  App.tsx                    — view stack (discriminated union), mobile/desktop split, draft cache
  lib/
    realtime.tsx             — WS→Query-cache bridge, optimistic send + reqId/pending-key dedup
    backStack.tsx            — BackStackProvider/useBackHandler: single re-armed history trap, LIFO
    socket.ts, api.ts        — socket.io client, fetch wrapper mapping error codes
    messageGroups.ts         — runs (5min window) / blocks / media stacks for ChatView
    masonry.ts               — shortest-column packing for the gallery grid
    waveform.ts              — client-side voice peaks (OfflineAudioContext, first-play decode)
    chats.ts, friends.ts, gallery.ts, media.ts, tags.ts, push.ts, pwa.ts, datetime.ts, auth.ts
  hooks/                     — useMessages (infinite keyset), useGallery, useChats, useIsMobile (≤768px)…
  components/                — ChatView (the big one: list, composer, selection, gestures),
                               Composer, MessageFocusMenu, MessageActions, MediaBubble, MediaStack,
                               VoiceMessage, RecordingBar, ChatGallery, GalleryScreen, MediaViewer,
                               TagSearchInput, ChatList, FriendsScreen, NewGroupScreen, AuthScreen,
                               Profile, InstallInstructions, ScreenHeader…
  sw.ts                      — custom service worker (injectManifest): push, notificationclick,
                               notification clear-on-open, update()-on-foreground + auto-reload

/deploy      — docker-compose.yml, Caddyfile, Dockerfiles, backup.sh, systemd timer, README (restore)
/docs        — this file, active feature plans (e.g. MESSAGE_SEARCH.md), archive/
```

## 5. Data model

**Truth:** `server/src/db/schema.ts` + `server/drizzle/` migrations (never edit an applied migration; add new ones). Tables:

`users`, `auth_identities`, `webauthn_credentials`, `invite_codes`, `sessions`, `push_subscriptions`, `friendships`, `chats`, `chat_members`, `messages`, `media`, `tags`, `media_tags`, `message_reactions`.

Modeling rules (locked):
- **DMs are 2-member chats with `is_group=false`** (`dm_key` = "minId:maxId" enforces pair uniqueness). Never special-case DMs — this is the future-calls branch point and nothing else.
- **Media belongs to a message; messages belong to a chat.** Gallery scoping and jump-to-message fall out of the join. `media.message_id` is NOT NULL: the message row is created at upload-mint time; WS fanout waits for complete. Abandoned uploads leave orphan processing rows (accepted; orphan sweep is roadmap).
- **Tags are per-chat** (`UNIQUE (chat_id, name)`), normalized (see §10), shared-wiki permissions, `tagged_by` = attribution only, `usage_count` maintained in app code.
- **Soft deletes** (`deleted_at`) everywhere users can delete; every read path filters them. Hard wipe is a roadmap item requiring an explicit logged override.
- **Replies:** `messages.reply_to_message_id` (nullable self-FK); API attaches a denormalized `ReplyPreview` (`{id, senderId, kind, preview, deleted}`) so clients render quotes without a second fetch and survive target deletion.
- **Reactions:** one row per `(message_id, user_id, emoji)`; API returns aggregated `ReactionSummary[]` (`{emoji, count, mine}`). Arbitrary emoji ≤32 chars stored; `ReactionLimits.quickEmojis` is the quick palette.
- **Auth is provider-ready by design:** `auth_identities` + `webauthn_credentials` exist from migration 001 but **nothing writes to them yet**. Invites authorize, providers authenticate; match OAuth users on `(provider, provider_user_id)`, never email; a user always keeps ≥1 login method.
- **Message search** (migration 006, docs/MESSAGE_SEARCH.md): `pg_trgm` extension + `idx_messages_body_trgm` gin trigram index on `messages.body` — substring search (ILIKE), not tsvector FTS, so mixed-language/partial-word queries behave like Discord's search instead of a stemmer.
- **Message edit** (migration 007, docs/MESSAGE_EDIT.md): `messages.edited_at` (nullable timestamptz), set the first time a message's body is edited. Own messages with a non-empty body only (text + media captions — the edit only ever touches `body`, never `media`); no time limit. No index needed — the existing trigram index covers edited bodies automatically.

## 6. REST API surface (actual, all under `/api`, cookie-authed unless noted)

```
POST /auth/register | /auth/login        (rate-limited, unauthed)
POST /auth/logout · GET /me · PATCH /me

GET  /friends
POST /friends/requests {username}        (mutual-pending auto-accepts)
POST /friends/requests/:userId/accept | /decline    (addressed by the OTHER user's id — no surrogate request id)

GET  /chats
POST /chats {memberIds[], name?}         (1 member → returns existing DM idempotently)
GET  /chats/:id/messages?before=&limit=  (keyset, id DESC)
GET  /chats/:id/messages/search?q=&from=&since=&until=&before=&limit=  (docs/MESSAGE_SEARCH.md; ≥1 filter required, else 400)
POST /chats/:id/read {messageId}
POST /chats/:id/messages/delete | /restore {messageIds[]}   (own messages only, batch all-or-nothing)
POST /chats/:id/messages/:messageId/edit {body}          (own messages only, body only — docs/MESSAGE_EDIT.md)
POST /chats/:id/messages/:messageId/reactions {emoji}
DELETE /chats/:id/messages/:messageId/reactions/:emoji

POST /media/uploads {chatId, kind, mime, sizeBytes}  → {mediaId, presignedPutUrl, message}
POST /media/:id/complete                 (HEAD verify + sniff, then process inline)
GET  /media/:id/url                      (short-lived presigned GET + thumb)
GET  /media/:id/tags · POST /media/:id/tags {name} · DELETE /media/:id/tags/:tagId

GET  /gallery/albums                     (chats with ≥1 ready media; cover = latest thumb-having item)
GET  /chats/:id/gallery?kind=&q=&before=&limit=   (kind: image|video|voice|visual; q: booru query)
GET  /chats/:id/tags?prefix=             (autocomplete, ranked usage then name)

GET  /push/config · POST /push/subscribe · POST /push/test
GET  /health
```

**Reserved route paths — do not build or repurpose:** `/auth/passkey/*` (register/login options+verify), `/auth/oauth/:provider/start|callback`, `/auth/identities/:provider/link|unlink`. See archive §6 for the full shapes.

Rules: every chat-scoped route calls `assertMember`. Keyset pagination only (`before` on `id`) — no OFFSET. Errors are `{error:{code,message}}`; clients map codes, never match message strings. DTOs live in `/shared` only.

## 7. WS protocol

Envelope (LOCKED): `{type, payload, ts, reqId?}` — `shared/src/ws.ts`. One connection per client, session-cookie handshake. Rooms: `chat:{id}` (message-scoped fanout) and `user:{id}` (chat-agnostic notices). Heartbeat ~25s (proxy timeouts).

Current types: `hello ping pong error` · `message.send message.new` · `chat.created` · `friend.request friend.accepted` · `media.ready` · `tag.added tag.removed` · `message.deleted message.restored` · `message.edited` · `reaction.added reaction.removed`.

Rules:
- New features add `type` values to the `WsType` registry — never a second envelope or side-channel.
- **`call.signal.*` / `call.state.*` prefixes are reserved** (guarded by `isReservedWsType`) for future calls.
- The `error` type goes to a single socket with `reqId` correlation, never to a room.
- Chat creation must join **all** members' live sockets to the new room, including the creator's (past bug).
- Client-side echo dedup: optimistic writes register a pending key (reqId for sends, `messageId:emoji:action` for reactions) consumed by the server's own echo; other users' frames always apply.

## 8. Media pipeline

- **Ceilings at mint time** (images 25MB, video 500MB, voice 20MB — `MediaLimits`), **verification at complete time** (R2 HEAD size + `file-type` magic-number sniff; mislabeled kind → 400 before processing). Never trust client mime/size.
- **Images:** sharp — `.rotate()` (EXIF orientation) then re-encode WebP **without metadata → EXIF/GPS stripped**, + 400px WebP thumb. HEIC decodes via sharp's bundled libvips.
- **Video:** ffmpeg poster frame (t=0.5s) + ffprobe dims/duration. No transcode — original stored as-is.
- **Voice:** ffmpeg → mono 48kHz AAC/m4a, always. One storage format; no playback-time format detection. Inputs vary by platform (iOS `audio/mp4`, Chrome `audio/webm;codecs=opus`) — both valid.
- Image/voice raw originals are deleted from R2 after re-encode; video keeps its original.
- Keys: `media/{chatId}/{mediaId}/orig.{ext}` + `.../thumb.webp` (chat-prefixed for future export/deletion). Presigned GETs ≤1h.
- Failure flips `media.status='failed'` cleanly; the placeholder message stays.

## 9. Auth, sessions, push

- Invite codes: single-use, admin CLI (`npm run invite create`). Registration requires one.
- Sessions: random 256-bit token in httpOnly/Secure/SameSite=Lax cookie ↔ `sessions` row; logout deletes the row. Login is case-insensitive (citext), no username enumeration. Auth routes rate-limited 10/min.
- Push: VAPID keys in env. Notify members with **no live socket in the chat's room**. Tiny payload `{chatId, chatName, senderName, preview}`; SW deep-links on click; per-chat notification `tag` (`chat-${id}`) enables clear-on-open. Delete subscription rows on 404/410 (iOS reinstall churn).
- iOS: push requires installed PWA (≥16.4) + user-gesture permission prompt ("Enable notifications" button, never auto-prompt).

## 10. Tags & gallery

- Normalization (`shared/src/tags.ts`, client AND server): trim → lowercase → spaces→hyphens → collapse; charset `[a-z0-9_-]`; ≤64 chars. Hinted live in the UI, never silent.
- Query language: booru AND + negation only (`beach -screenshots`). Parser in `shared/src/tags.ts`; an unresolvable positive tag short-circuits to an empty page.
- Gallery SQL lives in `server/src/media/gallery.ts` (raw SQL allowed there by convention). Positive matching = one `EXISTS` per required tag (the documented `unnest(...)::bigint[]` form fights the driver — see archive §15 2026-07-20).
- Gallery partitions into **Media** (masonry grid, `kind=visual` = image|video, All/Images/Videos sub-filter) and **Voice** (chat-skinned bubble list — never thumbnails). Day-level date sections in both. Multi-select batch tagging in Media only (client-side `Promise.allSettled` over per-media endpoints — no batch API).

## 11. Frontend architecture

- **Navigation:** no router. `App.tsx` holds a discriminated-union `View`; mobile (≤768px, `useIsMobile`) renders one full-screen view + bottom tabs (Chats/Gallery/Profile); desktop renders an icon rail + dual-pane Chats (360px list + chat). Crossing the breakpoint remounts `ChatView` — per-chat state that must survive lives in App-level ref caches (see `draftCacheRef`; copy that pattern).
- **Back gesture:** `lib/backStack.tsx` — single re-armed history trap; overlays/selection modes register LIFO handlers and close first; views unwind via `parentOf`; root back is inert (never exits the PWA). Every new overlay must register (`useBackHandler`).
- **Realtime layer:** `lib/realtime.tsx` writes WS frames into the Query cache; optimistic sends reconcile via reqId. Reconnect = invalidate + refetch.
- **Chat rendering:** `lib/messageGroups.ts` groups into runs (same sender, 5min) → blocks → optional media stacks; run-position-aware bubble corners; date/time dividers derived from loaded pages. Bare media renders bubble-less; captions get their own bubble.
- **Gestures (all hand-rolled Pointer Events — no gesture/animation library, ever):** long-press (500ms/10px) → focus menu or selection mode; swipe-to-reply (toward-center, 12px engage / 56px fire); double-tap-to-react (~250ms single-tap delay, accepted cost); MediaViewer swipe/pinch/double-tap (images) + swipe-with-56px-controls-exclusion (videos). Selection mode and viewers are mutually exclusive.
- **Stacking-context lesson (hard-won, 3 debugging rounds):** portalled fixed overlays MUST set an explicit `zIndex` on the outermost wrapper — `position:fixed` + `z-index:auto` paints at the parent's layer and loses to any positioned sibling regardless of inner z-values. See archive §15 2026-07-22.
- **Design tokens only** (`index.css` `@theme`): surface/surface-raised/surface-sunken, text-primary/secondary/muted, border, accent/accent-hover, radius + shadow scales. Dark mode via `prefers-color-scheme`. Exception precedent: accent-text-on-dark and error colors stay literal.
- **SW/update discipline:** custom `sw.ts`; API + WS never cached; `registration.update()` on foreground + auto-reload on `controllerchange`.

## 12. Platform reality (iOS is load-bearing, dev is Android)

Dev device: Samsung. Most users: iPhone. Anything likely to diverge on iOS Safari/installed-PWA gets ⚠️-flagged for the standing real-device gate — never silently called done. Known load-bearing quirks:

- `100dvh` not `100vh`; `env(safe-area-inset-*)` on bars/headers; `touch-action: manipulation` on controls; `overscroll-behavior: none`.
- MediaRecorder yields `audio/mp4` (iOS) vs `webm/opus` (Chrome); audio playback and AudioContext need a user gesture (`audio.play()` must be called synchronously in the gesture, before async work); `OfflineAudioContext` decode needs no gesture.
- Push: installed-PWA-only, gesture-gated prompt, subscription churn on reinstall.
- iOS may evict PWA origin storage after weeks — the app must cold-start cleanly from the API with zero local state (hard invariant: server is truth).
- Edge-swipe-back vs. rightward gestures (swipe-to-reply near the left edge) — flagged, unverified.
- Known-unbuilt: `visualViewport` composer pinning against the iOS keyboard; skeleton loaders.
- Real-device-verified so far (2026-07-21/22, prod): iOS push, iOS voice round-trip, install flow, Android PWA general pass. Still unverified on iOS: HEIC upload, cold-start session persistence, most touch-gesture feel, clipboard image paste (long-press → Paste with an image copied — `docs/IMAGE_PASTE.md`). Also needs a dev-device check: Android Samsung-keyboard clipboard-image paste.

## 13. Roadmap & icebox

**Roadmap (ordered; from archive §12):**
1. **Passkeys** (`@simplewebauthn/*`, discoverable credentials; schema + routes pre-reserved; rpID = locked domain).
2. **OAuth (Google)** — code + PKCE, full-page redirect; match on provider sub; invites still gate creation.
3. **Read receipts + typing indicators** (cheap WS types; `last_read_message_id` exists).
4. ~~Replies/reactions~~ — shipped 2026-07-22 out of order.
5. **E2EE v2** (libsodium sealed-box, per-chat keys wrapped per-member; tags stay plaintext — decide then).
6. **Calls** — see §15 below.
7. **Native wrappers** if PWA friction is real (Capacitor APK sideload / Tauri).
8. Server-side waveform peaks, video transcode pipeline, per-chat export/backup.
9. ~~Per-chat message search~~ — shipped 2026-07-22 out of order, `docs/MESSAGE_SEARCH.md`.

**Icebox (parked, with reasons — see archive §13 for full write-ups):**
- Hard-wipe of deleted messages (needs first background job + Postgres↔R2 cascade with no shared transaction; contradicts the soft-delete invariant — explicit override required).
- Voice rows joining gallery multi-select; any bulk action beyond tagging (bulk delete/download/share/move).
- R2 orphan sweep (referenced by media pipeline; not built).
- Global cross-chat search, `has:` filters, `from:@name` token parsing, fuzzy ranking (from the search plan).

## 14. Decision Log

Historical log (2026-07-17 → 2026-07-22, ~60 entries): **`docs/archive/BACKBONE.md` §15** — consult it before re-litigating anything that looks odd; most oddities are documented decisions. New entries go here:

| Date | Decision | Why |
|---|---|---|
| 2026-07-22 | MVP-era docs (BACKBONE, STAGE0, UI_REVAMP, UI8, MESSAGE_DELETE) archived to `docs/archive/`; this file becomes the living source of truth; CLAUDE.md rewritten to match | Owner's call: project matured past MVP framing. Stage gates and scope-freeze rules retired; invariants, platform reality, roadmap/icebox, and decision-log discipline carried forward |
| 2026-07-22 | Per-chat message search shipped (`docs/MESSAGE_SEARCH.md`): `pg_trgm` + gin trigram index for substring `ILIKE` matching (not tsvector FTS — handles mixed-language/partial-word/substring queries the way Discord's search does); mobile renders search as a full-screen overlay, desktop as a ~360px right-side panel that pushes the message column (Discord's own split) | Substring search over an unbounded, growing `messages.body` needs an index that doesn't degrade with chat size; FTS's word/stemmer model is the wrong shape for substring/mixed-language matching. Overlay-vs-panel split follows the same mobile/desktop divergence already established for the gallery and message-focus UI |
| 2026-07-22 | Native long-press menu (save/share image, selection loupe) suppressed on media *previews* — gallery tiles, album covers, chat photo/video thumbnails, stacks, grid-sheet tiles, selection thumbs — via the `.media-preview` CSS class (`-webkit-touch-callout`/`user-select`/`user-drag: none`, the iOS mechanism) paired with `suppressTouchContextMenu` (`lib/nativeMenu.ts`, swallows Android Chrome's touch/pen `contextmenu`). Full-screen `MediaViewer` keeps native behavior; desktop right-click keeps it everywhere (pointerType-gated) | Real-device finding: the browser's long-press menu fires over the app's own long-press gestures (gallery multi-select, chat focus menu/selection), making them unusable on media. Previews are app chrome — the intentional place to save/share an image is its full display, so native behavior is preserved exactly there |
| 2026-07-22 | Image paste in the composer shipped (`docs/IMAGE_PASTE.md`): `onPaste` on the composer `<textarea>` reuses the attach-button path (`onPickFiles` → `ChatView.handleFilesPicked`) wholesale — no new upload code, no filtering in `Composer`. Mixed clipboard (file + text) → files win, text dropped. `Composer`'s `onRecordingError` prop generalized to `onError` to also cover the paste-while-uploading error | Owner-requested QoL pull-forward, not on the §13 roadmap. Desktop `Ctrl+V` (screenshot tools) and mobile long-press → Paste were both missing; the attach-button flow already has no pre-send preview/confirm step, so paste follows the same "picking is sending" precedent rather than inventing one |
| 2026-07-22 | Message edit shipped (`docs/MESSAGE_EDIT.md`, migration 007 `messages.edited_at`): own messages with a non-empty body only (text + media captions — the edit only ever touches `body`, never `media`), no time limit. New `message.edited` WS type carries the full updated `Message` (same "replace wholesale" shape as `message.restored`), emitted only on a real change. Edited indicator is a small muted "edited" label hanging off the bubble's center-facing edge, vertically centered on the bubble itself (absolutely positioned inside it — revised twice same-day from below-the-bubble, then row-inline: no added height, and no drift when reaction pills are present). Client applies the edit REST-first (mutation response patches the cache); the WS echo is an idempotent replace, no dedup bookkeeping needed | Owner-requested pull-forward, not on the §13 roadmap — same posture as image paste above. Unlimited edit window fits the closed-friend-circle trust model (no impersonation/abuse surface to police); scoping to body-only (never media) keeps the media pipeline's immutability invariants untouched |

## 15. 🔮 Call-readiness invariants (still binding)

No call code exists; these keep calls bolt-on-able:
1. DMs stay 2-member chats (`is_group=false`) — the only branch point.
2. `call.signal.*` / `call.state.*` WS prefixes stay reserved.
3. TURN awareness: the VPS will eventually host coturn; don't install it now.

## 16. Working on Den

- **Feature workflow:** non-trivial features get a short plan doc in `docs/` (pattern: `MESSAGE_SEARCH.md`) covering scope, invariants touched, verification; roadmap/icebox updates and a §14 entry land with the change, not after.
- **Definition of done:** `npm run typecheck && npm run lint && npm run test` green; server-side behavior verified with a scripted multi-account flow against the compose stack (established pattern — see archive §14 stage verifications); iOS-divergent UI flagged for the device gate.
- **Commands:** `npm run dev` (Vite 5173 + API 3000) · `npm run db:generate` / `db:migrate` · `docker compose -f deploy/docker-compose.yml up -d` · `npm run invite create`.
- **Backups:** nightly systemd timer → `pg_dump -Fc` → R2 `backups/`, retention `BACKUP_KEEP` (default 7), size + `pg_restore --list` validated. ⚠️ Restore drill still unperformed — until then it's a hypothesis, not a backup (`deploy/README.md`).
