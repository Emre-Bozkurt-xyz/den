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
    waveform.ts              — voice waveform peaks from PCM (44 RMS buckets, 0–255; docs/VOICE_WAVEFORM.md)
    r2.ts                    — S3 clients: operational + signing-only (public endpoint; SigV4 signs Host)
    gallery.ts               — gallery query (raw SQL for tag matching lives here, documented)
    tags.ts                  — tag registry, usage counts, add/remove
  realtime/rooms.ts          — chatRoom()/userRoom() naming
  push/                      — web-push send, 404/410 subscription pruning
  routes/                    — auth, chats, friends, gallery, media, push, health (+ voice-poc, legacy)
  scripts/                   — invite CLI, backup.ts, backfill-dims.ts, backfill-waveform.ts (one-offs)
  db/schema.ts               — Drizzle schema (source of truth for the data model)

/app/src
  App.tsx                    — view stack (discriminated union), mobile/desktop split, draft cache
  lib/
    realtime.tsx             — WS→Query-cache bridge, optimistic send + reqId/pending-key dedup
    backStack.tsx            — BackStackProvider/useBackHandler: single re-armed history trap, LIFO
    socket.ts, api.ts        — socket.io client, fetch wrapper mapping error codes
    messageGroups.ts         — runs (5min window) / blocks / media stacks for ChatView
    masonry.ts               — shortest-column packing for the gallery grid
    waveform.ts              — legacy-row fallback voice-peak decoder (OfflineAudioContext, first-play); real peaks come stored on MediaInfo.waveform
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

`users`, `auth_identities`, `webauthn_credentials`, `invite_codes`, `sessions`, `push_subscriptions`, `friendships`, `chats`, `chat_members`, `messages`, `media`, `tags`, `media_tags`, `message_reactions`, `embeds`.

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
- **Voice waveforms** (migration 0007 SQL file, docs/VOICE_WAVEFORM.md): `media.waveform` (nullable jsonb) — 44 RMS peaks quantized 0–255, computed server-side at processing time. Voice only; null for image/video and for legacy voice rows until `scripts/backfill-waveform.ts` runs.
- **Delivery receipts** (migration 009, docs/RECEIPTS.md): `chat_members.last_delivered_message_id` (nullable bigint, no FK — mirrors `last_read_message_id`) is a true device-delivery watermark, distinct from the read watermark. Both are **guarded-monotonic writes** (`WHERE watermark IS NULL OR < :id`) — a stale/out-of-order caller can never move either backwards. Per-user, not per-device: one watermark per `(chat_id, user_id)` row, same as today's unread counts.
- **Embeds — framework + Instagram** (migration 010, docs/EMBEDS.md §4): `messages.kind` gains `'embed'`. `embeds` belongs to a message exactly as `media` does (`message_id` NOT NULL FK, one row per embed message): `provider` ('instagram'|'vault'), `status` ('processing'|'ready'|'failed'), a provider-agnostic card snapshot (`title`/`subtitle`/`description`/`thumb_key`/`canonical_url`/`provider_ref`/`content_kind`), `action_type` ('external'|'read'|'portal', defaults 'external'), `data` jsonb for provider extras. Same async lifecycle as media: `message.send` sniffs the body for a recognized URL (`shared/src/embeds.ts`'s `detectEmbedUrl`, also used by the composer's paste-detect chip) → mints a `'processing'` placeholder + `message.new` → resolves in the background → `embed.ready`. Only `instagram` has a resolver so far (`server/src/embeds/registry.ts`'s plain provider→resolver map); `vault` is schema-ready for Phase 3. *(Phase 2's `vault_links` table and Vault account linking are implemented but not yet in `main` — see §13.)*

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
POST /chats/:id/read {messageId}         (docs/RECEIPTS.md — also advances the delivered watermark; broadcasts message.read/message.delivered on each real advance)
GET  /chats/:id/receipts                 (docs/RECEIPTS.md — every member's read/delivered watermarks)
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

Embed messages have no dedicated REST route — a recognized URL in a `message.send` WS frame mints and resolves them (docs/EMBEDS.md §4.3); the resulting card rides the normal `Message.embed` field on every existing message-listing route above.

**Reserved route paths — do not build or repurpose:** `/auth/passkey/*` (register/login options+verify), `/auth/oauth/:provider/start|callback`, `/auth/identities/:provider/link|unlink`. See archive §6 for the full shapes.

Rules: every chat-scoped route calls `assertMember`. Keyset pagination only (`before` on `id`) — no OFFSET. Errors are `{error:{code,message}}`; clients map codes, never match message strings. DTOs live in `/shared` only.

## 7. WS protocol

Envelope (LOCKED): `{type, payload, ts, reqId?}` — `shared/src/ws.ts`. One connection per client, session-cookie handshake. Rooms: `chat:{id}` (message-scoped fanout) and `user:{id}` (chat-agnostic notices). Heartbeat ~25s (proxy timeouts).

Current types: `hello ping pong error` · `message.send message.new` · `chat.created` · `friend.request friend.accepted` · `media.ready` · `tag.added tag.removed` · `message.deleted message.restored` · `message.edited` · `reaction.added reaction.removed` · `delivered.ack` (client→server, batched, fire-and-forget) · `message.delivered message.read` (docs/RECEIPTS.md — room broadcasts, only on a real watermark advance) · `embed.ready` (docs/EMBEDS.md §4.2 — room broadcast, identical shape/reasoning to `media.ready`: the resolved card replaces the `'processing'` placeholder in place).

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
- **Voice:** ffmpeg → mono 48kHz AAC/m4a, always. One storage format; no playback-time format detection. Inputs vary by platform (iOS `audio/mp4`, Chrome `audio/webm;codecs=opus`) — both valid. A second ffmpeg pass decodes the m4a to 8kHz mono PCM for stored waveform peaks (`media.waveform`, docs/VOICE_WAVEFORM.md) — best-effort, null on failure.
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

**In flight:** Embeds & Vault portal (`docs/EMBEDS.md`, pulled forward by owner decision, off the ordered roadmap below). **Phase 1 shipped:** the embed framework + Instagram provider. **Phase 2 (Vault account linking, outbound OAuth client) is code-complete but not yet in `main`** — it activates only once the Vault side exists (`the-vault/docs/DEN_EMBED_BRIDGE.md` §A, `GET /api/me` + OAuth client). Phases 3–4 (Vault embeds/read, the Stage + live portal editing) not started; they depend on Vault §B/§C, which don't exist yet.

**Roadmap (ordered; from archive §12):**
1. **Passkeys** (`@simplewebauthn/*`, discoverable credentials; schema + routes pre-reserved; rpID = locked domain).
2. **OAuth (Google)** — code + PKCE, full-page redirect; match on provider sub; invites still gate creation.
3. ~~Read receipts~~ — shipped 2026-07-23 out of order, `docs/RECEIPTS.md` (sent/delivered/seen/failed). **Typing indicators remain** on the roadmap (cheap WS types, not built here).
4. ~~Replies/reactions~~ — shipped 2026-07-22 out of order.
5. **E2EE v2** (libsodium sealed-box, per-chat keys wrapped per-member; tags stay plaintext — decide then).
6. **Calls** — see §15 below.
7. **Native wrappers** if PWA friction is real (Capacitor APK sideload / Tauri).
8. ~~Server-side waveform peaks~~ (shipped 2026-07-22, `docs/VOICE_WAVEFORM.md`), video transcode pipeline, per-chat export/backup.
9. ~~Per-chat message search~~ — shipped 2026-07-22 out of order, `docs/MESSAGE_SEARCH.md`.

**Icebox (parked, with reasons — see archive §13 for full write-ups):**
- Hard-wipe of deleted messages (needs first background job + Postgres↔R2 cascade with no shared transaction; contradicts the soft-delete invariant — explicit override required).
- Voice rows joining gallery multi-select; any bulk action beyond tagging (bulk delete/download/share/move).
- R2 orphan sweep (referenced by media pipeline; not built).
- Global cross-chat search, `has:` filters, `from:@name` token parsing, fuzzy ranking (from the search plan).
- Instagram full-reel rehost, Stage pinned-messages/notes, non-Vault generic link unfurl, per-viewer live (non-portal) Vault ACL reconciliation (docs/EMBEDS.md §Bookkeeping — Phase 3/4 icebox, applies once those phases start).

## 14. Decision Log

Historical log (2026-07-17 → 2026-07-22, ~60 entries): **`docs/archive/BACKBONE.md` §15** — consult it before re-litigating anything that looks odd; most oddities are documented decisions. New entries go here:

| Date | Decision | Why |
|---|---|---|
| 2026-07-22 | MVP-era docs (BACKBONE, STAGE0, UI_REVAMP, UI8, MESSAGE_DELETE) archived to `docs/archive/`; this file becomes the living source of truth; CLAUDE.md rewritten to match | Owner's call: project matured past MVP framing. Stage gates and scope-freeze rules retired; invariants, platform reality, roadmap/icebox, and decision-log discipline carried forward |
| 2026-07-22 | Per-chat message search shipped (`docs/MESSAGE_SEARCH.md`): `pg_trgm` + gin trigram index for substring `ILIKE` matching (not tsvector FTS — handles mixed-language/partial-word/substring queries the way Discord's search does); mobile renders search as a full-screen overlay, desktop as a ~360px right-side panel that pushes the message column (Discord's own split) | Substring search over an unbounded, growing `messages.body` needs an index that doesn't degrade with chat size; FTS's word/stemmer model is the wrong shape for substring/mixed-language matching. Overlay-vs-panel split follows the same mobile/desktop divergence already established for the gallery and message-focus UI |
| 2026-07-22 | Native long-press menu (save/share image, selection loupe) suppressed on media *previews* — gallery tiles, album covers, chat photo/video thumbnails, stacks, grid-sheet tiles, selection thumbs — via the `.media-preview` CSS class (`-webkit-touch-callout`/`user-select`/`user-drag: none`, the iOS mechanism) paired with `suppressTouchContextMenu` (`lib/nativeMenu.ts`, swallows Android Chrome's touch/pen `contextmenu`). Full-screen `MediaViewer` keeps native behavior; desktop right-click keeps it everywhere (pointerType-gated) | Real-device finding: the browser's long-press menu fires over the app's own long-press gestures (gallery multi-select, chat focus menu/selection), making them unusable on media. Previews are app chrome — the intentional place to save/share an image is its full display, so native behavior is preserved exactly there |
| 2026-07-22 | Image paste in the composer shipped (`docs/IMAGE_PASTE.md`): `onPaste` on the composer `<textarea>` reuses the attach-button path (`onPickFiles` → `ChatView.handleFilesPicked`) wholesale — no new upload code, no filtering in `Composer`. Mixed clipboard (file + text) → files win, text dropped. `Composer`'s `onRecordingError` prop generalized to `onError` to also cover the paste-while-uploading error | Owner-requested QoL pull-forward, not on the §13 roadmap. Desktop `Ctrl+V` (screenshot tools) and mobile long-press → Paste were both missing; the attach-button flow already has no pre-send preview/confirm step, so paste follows the same "picking is sending" precedent rather than inventing one |
| 2026-07-22 | Chat media previews reserve their final layout box before the image bytes load (`app/src/components/PreviewImage.tsx`, from stored `media.width/height`), fixing "chat opens scrolled above the bottom after a refresh" (scroll-to-bottom was measuring zero-height `<img>`s that inflated after decode). Stored dimensions now mean *displayed* orientation: image processing swaps sharp's pre-rotation metadata for EXIF orientations 5–8, ffprobe swaps coded dims when the display-matrix rotation is ±90°. Pre-fix rows with swapped dims (`PreviewImage` self-heals them on load, but the reservation is still wrong pre-load) are corrected by `scripts/backfill-dims.ts` — dry-run default, `--apply` to write, probes stored thumbs/posters as ground truth (added same day after real-device testing showed legacy media kept the scroll deficit alive) | Reserving from known dimensions is deterministic and also removes layout shift during upward pagination; a load-event re-scroll would have fought user scrolling. Backfill would require re-probing every stored object from R2 for a cosmetic, self-limiting inaccuracy — not worth the operational step |
| 2026-07-22 | Message edit shipped (`docs/MESSAGE_EDIT.md`, migration 007 `messages.edited_at`): own messages with a non-empty body only (text + media captions — the edit only ever touches `body`, never `media`), no time limit. New `message.edited` WS type carries the full updated `Message` (same "replace wholesale" shape as `message.restored`), emitted only on a real change. Edited indicator is a small muted "edited" label hanging off the bubble's center-facing edge, hugging the bubble's bottom corner (absolutely positioned inside it — iterated same-day from below-the-bubble → row-inline → bubble-centered: no added height, no drift when reaction pills are present). Client applies the edit REST-first (mutation response patches the cache); the WS echo is an idempotent replace, no dedup bookkeeping needed | Owner-requested pull-forward, not on the §13 roadmap — same posture as image paste above. Unlimited edit window fits the closed-friend-circle trust model (no impersonation/abuse surface to police); scoping to body-only (never media) keeps the media pipeline's immutability invariants untouched |
| 2026-07-22 | Voice waveforms are server-computed at processing time (`docs/VOICE_WAVEFORM.md`): `media.waveform` jsonb stores 44 RMS peaks (0–255) from an 8kHz mono PCM decode of the transcoded m4a; `MediaInfo.waveform` ships them; the bubble renders real bars on mount. The client's fake `placeholderPeaks` pattern is deleted — rows without stored peaks show an honest uniform-hairline loading state and self-heal via the surviving first-play decoder. `scripts/backfill-waveform.ts` fills legacy rows. Bar count `VOICE_WAVEFORM_BARS = 44` lives in `/shared` | Owner's call: the placeholder was a filled-in facade — the waveform must be real when the bubble loads, with only an honest loading indicator otherwise. The waveform half of §13 item 8 pulled forward (video transcode stays); computing at processing time costs one cheap ffmpeg pass on bytes already in hand, and storing on the row means zero extra fetches to render |
| 2026-07-23 | Delivery states + read receipts shipped (`docs/RECEIPTS.md`, migration 009 `chat_members.last_delivered_message_id`): **Delivered means true device-delivery** (a client ack that a device actually received the message), not just "the server persisted it" — WhatsApp-style, not the cheaper server-ack-only semantics. **Seen is Messenger-style avatars**: each other member's avatar sits under the newest of *my* messages they've read (their read watermark clamped down to a message I actually sent), max 3 + `+N` overflow; when a message has ≥1 seen avatar its Sent/Delivered text is suppressed entirely (avatars say more). Status text (Sent/Delivered) only ever renders on my newest non-local message, using an **all-other-members** rule for Delivered (any single holdout keeps it at Sent) — never special-cased for DMs (a DM is just the 2-member case of the same rule). `markRead`/`markDelivered` became guarded-monotonic (fixing a pre-existing "a stale client can move `last_read_message_id` backwards" bug, made user-visible now that the watermark drives rendered UI, not just an unread count) and validate the message belongs to the chat. **Failed-send retry is client-only, deliberately**: a failed send never reached the server, so per "server is truth" there is nothing to persist — the bubble persists locally (red "Failed to send — tap to retry" label, long-press → a reduced Discard-only focus menu) but is gone on refresh, which is correct, not a gap to close later | Owner calls, 2026-07-23. True delivery (not server-ack) was chosen because a closed friend-circle app is exactly the case where "did their phone actually get this" is worth a real client ack over the cheaper, less honest server-side proxy. The avatar-clamp/all-others rules were chosen because they fall out correctly for groups (and DMs, as their 1-other-member special case) with no extra branching. Client-only failed-state was chosen to avoid inventing an offline outbox/queue (explicitly out of scope) while still never silently discarding a user's typed message the way the pre-existing behavior did |
| 2026-07-23 | Receipts revised same-day after owner review (`docs/RECEIPTS.md` §3): **(a)** 2-member chats render the seen marker as plain "Seen" text instead of the other member's avatar — keyed on member count, not `is_group`, the same presentation-only precedent as DM display-name derivation, so §15's "never special-case DMs" stays intact. **(b) Reply supersedes receipt**: a member's own later loaded message drops their seen marker (per-member — in a group, B's reply says nothing about C, so C's marker survives) and counts them as a seer for status-text suppression even when their watermark lags (in this app composing requires an open, visible chat that fires markRead, so a member's message is proof they saw everything before it) | Owner feedback on the shipped UI: an avatar identifying the only other person in a DM is redundant, and a seen marker (or stale "Delivered") under a message the other person already replied to is noise — the reply itself is the receipt. The watermark stays the placement source: a position derived from a member's own message would always sit below that message and be suppressed by the reply rule, so no "message-implies-read" write path is needed anywhere |
| 2026-07-23 | iOS keyboard composer pinning implemented (`docs/IOS_KEYBOARD.md`, `app/src/hooks/useKeyboardInset.ts`): a `visualViewport` `resize`/`scroll` listener computes `keyboardInset = window.innerHeight - visualViewport.height - visualViewport.offsetTop` (clamped ≥ 0, rAF-coalesced), writes it to `--kb-inset` on the document root, and is iOS-gated on the existing `isIosSafari()` check (`lib/pwa.ts`). `Composer` swaps its `env(safe-area-inset-bottom)` padding for the live `--kb-inset` value once it's positive (dropping the safe-area term rather than adding both); `ChatView` re-runs its existing scroll-to-bottom on the keyboard's closed→open edge only, not every intermediate px, so it doesn't fight the user's own scroll position once already open. Gate off (Android/desktop): the hook is a no-op, `--kb-inset` is never written, today's behavior is unchanged | Chosen over relying on the `interactive-widget=resizes-content` viewport-meta value alone because iOS field support for it is uneven across the versions in use; that value is left as a candidate future *complement*, layered under this JS path, not a replacement for it. **Code-complete, typecheck/lint/test green — still awaiting the real-device iPhone sign-off gate (docs/IOS_KEYBOARD.md §4/§6, Safari + installed PWA + the Android regression check) before this can be called shipped**; PROJECT.md §12's "Known-unbuilt" line stays put until that passes |
| 2026-07-23 | Embed framework + Instagram provider pulled forward, off the §13 roadmap (`docs/EMBEDS.md` Phase 1, migration 010): a message can carry a provider-rendered card (`messages.kind='embed'`, `embeds` table) instead of/beside text — one shared client renderer (`EmbedCard.tsx`) for every provider, a server-side resolver registry (currently just `instagram`). Lifecycle mirrors media exactly: `message.send`'s body is sniffed for a recognized URL (`shared/src/embeds.ts`'s `detectEmbedUrl`, also driving the composer's paste-detect chip) → `'processing'` placeholder + `message.new` → async resolve → `embed.ready`. Instagram's OG-tag scrape is Den's first server-side fetch of a user-supplied URL — SSRF-contained via a fixed host allowlist (`instagram.com` for the page, `cdninstagram.com`/`fbcdn.net` for the CDN image), HTTPS-only, manual redirect handling re-checked against the allowlist per hop, a response-size cap, and a hard timeout; the `og:image` snapshot is re-encoded through sharp to R2 (strips metadata, verifies-by-decoding). No OG data found (private/deleted/login-walled) is treated as a resolver failure → `status='failed'`, client renders a plain link fallback, never a broken half-card | Framework-first de-risks the whole embed concept (card renderer, provider seam, message-mint lifecycle) with zero Vault coupling before Phase 2/3 add real cross-product complexity. Server-side URL fetching is new enough surface (first of its kind in Den) to treat as hostile input by default rather than case-by-case |

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
