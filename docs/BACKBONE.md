# Project Backbone — Private Social/Chat App (MVP)

> **Working name:** **Den**
> **Domain:** `den.ems-place.com` (locked — see §5 rpID trap, §14 Stage 0)
> **Status:** Pre-development
> **Last updated:** 2026-07-17
>
> This document is the single source of truth until MVP ships. When a decision changes, update this file — don't let it rot. Anything marked ⚠️ is a known trap; anything marked 🔮 is post-MVP and must not leak into MVP scope.

---

## 1. Vision & Non-Negotiables

A private chat + media app for a closed circle of friends/family, where **you own the server and the data**.

**Non-negotiables:**
1. **Self-hosted.** Runs on the existing VPS + FRP/reverse-proxy setup. Postgres for data, Cloudflare R2 for media blobs. No third-party analytics, no external services in the request path (Web Push relay is the one unavoidable exception — it goes through Apple/Google push infrastructure, but payloads can be minimal/encrypted).
2. **$0 to Apple.** iOS distribution is a PWA added to home screen. No App Store, no dev license.
3. **Invite-only.** No public signup. Registration requires an invite code. This is the entire spam/abuse/moderation story for MVP — the trust boundary is at the door.
4. **One codebase for all platforms.** PWA-first. Windows/Android/iOS all consume the same web app. Native wrappers (Capacitor/Tauri) are 🔮 and only if a real need appears.
5. **Client is a cache, server is the truth.** iOS can and will evict PWA storage. Nothing exists only on the client, ever.

**Platform priorities:**
- **Primary/dev platform: Android (Samsung).** This is the daily-driver and where day-to-day dev testing happens. Android PWA support is the good case (full push, proper install prompt, MediaRecorder gives webm/opus) — don't let it lull you.
- **iOS is a first-class *guest* platform**, not the main focus — but most of the circle is on iPhone, so iOS breakage = most users broken. All ⚠️ iOS notes in this doc stay load-bearing.
- ⚠️ **Logistics risk: you don't own an iPhone.** Recruit one iOS friend as a standing beta tester in week 1 (Stage 0 push PoC needs their phone). Remote-debugging iOS Safari requires a Mac (or use `eruda`/remote logging endpoint injected in dev builds — set this up early, you will need console output from that iPhone).
- Desktop (Windows) via browser/installed PWA: expected to Just Work; test each stage but don't design around it.

**Explicitly NOT goals for MVP:**
- E2EE (🔮 v2 — see §12). MVP privacy model = TLS in transit + trusted server + encrypted disk. Be honest about this in your own head: the server admin (you) can read everything.
- Calls (🔮 — but see §11 for what MVP must do *now* to not paint us into a corner).
- Public discovery, search for users, moderation/reporting flows, blocking.
- Message editing/deletion sync semantics beyond soft-delete.
- Read receipts / typing indicators (nice-to-have; add only if MVP core is done early — they're WebSocket events, cheap once the envelope exists).

---

## 2. Feature Scope (MVP Definition of Done)

The MVP is done when all of the following work on **your Samsung (installed PWA)**, **a friend's iPhone (installed PWA)**, and a desktop browser:

| # | Feature | Definition of done |
|---|---------|-------------------|
| 1 | Auth | Register with invite code, login, persistent session, logout |
| 2 | Friending | Send request by username, accept/decline, friends list; friendship gates DMs and group adds |
| 3 | DMs | Text messages, real-time via WebSocket, history persisted, works after reconnect |
| 4 | Group chats | Create group, add friends, name it, same messaging as DMs |
| 5 | Media messages | Send/receive images, videos, voice messages; thumbnails; upload progress; playback inline |
| 6 | Gallery | Per-chat media browser reachable from chat + top-level gallery page listing chats as albums; jump-to-message from any media item |
| 7 | Tagging | Add/remove tags on media (any chat member); per-chat tag registry; autocomplete with usage counts |
| 8 | Filtering | Booru-style query in gallery: `tag1 tag2 -tag3` (AND + negation), plus media-type filter (image/video/voice) |
| 9 | Push | Web Push notification for new messages when app is closed, on iOS 16.4+ installed PWA, Android, desktop |
| 10 | PWA polish | Manifest, service worker, install instructions screen, safe-area-correct layout, dark mode |

If a feature isn't in this table, it is not MVP. Add it to §13 (Icebox) instead of building it.

---

## 3. Tech Stack (Decided)

| Layer | Choice | Why / Notes |
|-------|--------|-------------|
| Frontend | **Vite + React 19 + TypeScript** | No SSR needed for an authed app; Vite keeps it simple. (Next.js acceptable if you want file routing, but SSR buys nothing here and complicates the service worker.) |
| Styling | Tailwind | Fast iteration; matches IG-style utility-heavy UI work |
| State/data | TanStack Query for server state + a thin WebSocket layer that writes into the Query cache | Avoids hand-rolled cache invalidation |
| Backend | **Node + Fastify + TypeScript** | Shares types with frontend (one repo, shared `types/` package). WebSockets first-class via `@fastify/websocket` or raw `ws`. |
| DB | **PostgreSQL** | On the VPS. Migrations via `node-pg-migrate` or Drizzle. Pick ONE ORM/query approach at project start — suggested: **Drizzle** (typed, SQL-shaped, no magic). |
| Media storage | **Cloudflare R2** | Reuse the Vault pipeline knowledge. Presigned URLs for upload & download. |
| Media processing | `sharp` (image thumbs), `ffmpeg` (video thumbs + audio transcode) | Runs on the VPS in the API process or a small worker. ffmpeg must be installed on the server — check early. |
| Push | `web-push` (VAPID) | Generate VAPID keypair once, store in env. |
| Realtime | WebSocket (raw `ws` or socket.io) | Decision: **socket.io** for reconnection/rooms out of the box — hand-rolling reconnect + heartbeat + room fanout is undifferentiated work. Revisit only if bundle size offends. |
| Auth | Session cookie (httpOnly, Secure, SameSite=Lax) + server-side session table. **Identity layer designed OAuth-ready from day one** (see §5: `auth_identities` table, nullable `password_hash`) | Simpler and safer than JWT for a first-party single-domain app. MVP ships password+invite only; Google/other OAuth bolts on post-MVP *without a migration* because identities are already a separate table. ⚠️ Cookie must work in installed-PWA context on iOS — it does, same-origin, but test in week 1. |
| Deploy | Docker Compose on the VPS (api, postgres, caddy/nginx) | You already run this pattern. TLS via existing reverse proxy. |

**Repo layout (monorepo):**
```
/app        — Vite React PWA
/server     — Fastify API + WS + workers
/shared     — TS types shared by both (message envelope, API DTOs)
/deploy     — docker-compose.yml, Caddyfile/nginx conf, migration runner
BACKBONE.md — this file
```

---

## 4. Architecture Overview

```
[iOS PWA] [Android PWA] [Desktop browser]
      │ HTTPS (REST + presigned R2 URLs)
      │ WSS (realtime)
      ▼
[Caddy/nginx on VPS] ──► [Fastify API + WS]──► [Postgres]
                              │    │
                              │    └──► [web-push → APNs/FCM relay]
                              ▼
                      [media worker: sharp/ffmpeg]
                              │
                              ▼
                        [Cloudflare R2]
```

**Core flows:**
- **Send text:** client → WS `message.send` → server persists → fanout to online members via WS rooms → push to offline members.
- **Send media:** client asks API for presigned R2 upload URL → uploads directly to R2 → notifies API "upload complete" → server enqueues thumbnail/transcode job → message row created with `status=processing` → job completes → message updated + WS fanout. ⚠️ Client never proxies media bytes through the API server; R2 direct upload/download only. The API only mints presigned URLs and records metadata.
- **View media:** client requests short-lived presigned GET URLs (or a signed CDN URL pattern). Never make R2 objects public.

**WebSocket envelope (LOCKED — changing this later hurts):**
```ts
// shared/ws.ts
type WsEnvelope<T extends string, P> = {
  type: T;          // e.g. "message.new", "message.send", "chat.created",
                    //      "tag.added", "presence.update", ...
                    //      🔮 reserved prefixes: "call.signal.*", "call.state.*"
  payload: P;
  ts: number;       // server timestamp on server→client frames
  reqId?: string;   // client-generated id for request/ack correlation
};
```
Every feature speaks through this envelope. Call signaling later is *just more `type` values* — no protocol rework.

---

## 5. Data Model (DDL-level)

Design principles baked in:
- **DMs are group chats with 2 members and `is_group=false`.** No special-casing DMs anywhere in schema or code paths. (This keeps 🔮 call logic split clean later.)
- **Media belongs to a message; messages belong to a chat.** Gallery scoping falls out of the join, and "jump to message" is free.
- **Tags are per-chat.** `beach-trip` in the family chat ≠ `beach-trip` in the friends chat. Keeps autocomplete relevant, prevents registry pollution.
- Soft deletes (`deleted_at`) everywhere users can delete; never hard-delete rows in MVP.

```sql
-- users & auth ---------------------------------------------------------
CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      CITEXT UNIQUE NOT NULL,        -- CITEXT: case-insensitive lookups
  display_name  TEXT NOT NULL,
  email         CITEXT UNIQUE,                 -- nullable in MVP; OAuth account-linking key later
  password_hash TEXT,                          -- argon2id; NULLABLE: OAuth-only accounts have none
  avatar_key    TEXT,                          -- R2 key, nullable
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- OAuth-ready identity layer. MVP only ever inserts provider='password' rows
-- conceptually (password lives on users for simplicity), but this table exists
-- from migration 001 so adding Google later is an INSERT pattern, not a migration.
CREATE TABLE auth_identities (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id),
  provider         TEXT NOT NULL,              -- 'google' | 'github' | ... ('password' implicit)
  provider_user_id TEXT NOT NULL,              -- Google 'sub' claim — STABLE id. ⚠️ never key on email
  email_at_link    CITEXT,                     -- email as reported at link time (informational)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
-- Rules (LOCKED):
--  * A user may have password AND/OR any number of provider identities (account linking
--    from settings, requires being logged in — never auto-merge accounts by email match).
--  * Login flow later: OAuth callback → look up (provider, provider_user_id) →
--    exists ⇒ create session; not exists ⇒ if invite-code onboarding pending, create user.
--    OAuth does NOT bypass invite codes — providers authenticate, invites authorize.
--  * A user must always retain ≥1 login method (block deleting the last one).

-- Passkey-ready layer (same philosophy as auth_identities: ships in migration 001,
-- MVP writes nothing here; passkeys are post-MVP roadmap item #1).
CREATE TABLE webauthn_credentials (
  id            TEXT PRIMARY KEY,              -- credential ID (base64url) from authenticator
  user_id       BIGINT NOT NULL REFERENCES users(id),
  public_key    BYTEA NOT NULL,                -- COSE public key
  sign_count    BIGINT NOT NULL DEFAULT 0,     -- clone-detection counter; update every auth
  transports    TEXT[],                        -- ['internal','hybrid',...] hints for browser
  device_label  TEXT,                          -- user-facing: "Emre's S24", "Dad's iPhone"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);
-- ⚠️ rpID TRAP: passkeys bind permanently to the domain (rpID). Once the first real
-- passkey is registered, the app's domain is FROZEN — a domain move invalidates every
-- credential. Pick the final production domain in Stage 0, before Stage 1 starts.
-- Users may register multiple passkeys (phone + laptop); the "≥1 login method" rule
-- counts passkeys, password, and OAuth identities together.

CREATE TABLE invite_codes (
  code       TEXT PRIMARY KEY,                 -- random, generated by admin CLI
  created_by BIGINT REFERENCES users(id),
  used_by    BIGINT REFERENCES users(id),
  used_at    TIMESTAMPTZ
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,                 -- random 256-bit token, cookie value
  user_id    BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  user_agent TEXT
);

CREATE TABLE push_subscriptions (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- ⚠️ prune subscriptions on 404/410 from push service (iOS reinstalls churn these)

-- friendships ----------------------------------------------------------
CREATE TABLE friendships (
  user_a     BIGINT NOT NULL REFERENCES users(id),  -- invariant: user_a < user_b
  user_b     BIGINT NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  requested_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);

-- chats ----------------------------------------------------------------
CREATE TABLE chats (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  is_group   BOOLEAN NOT NULL,
  name       TEXT,                              -- null for DMs (derive from other member)
  avatar_key TEXT,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_members (
  chat_id   BIGINT NOT NULL REFERENCES chats(id),
  user_id   BIGINT NOT NULL REFERENCES users(id),
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_message_id BIGINT,                  -- unread counts
  PRIMARY KEY (chat_id, user_id)
);
-- Enforce in app code: DM chats have exactly 2 members and a unique pair
-- (partial unique index on a normalized dm_key column is the robust option):
--   ALTER TABLE chats ADD COLUMN dm_key TEXT UNIQUE; -- "minId:maxId", null for groups

-- messages -------------------------------------------------------------
CREATE TABLE messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id    BIGINT NOT NULL REFERENCES chats(id),
  sender_id  BIGINT NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('text','image','video','voice','system')),
  body       TEXT,                              -- text content or caption
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX idx_messages_chat ON messages (chat_id, id DESC);  -- pagination

-- media ----------------------------------------------------------------
CREATE TABLE media (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES messages(id),
  uploader_id BIGINT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL CHECK (kind IN ('image','video','voice')),
  r2_key      TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size_bytes  BIGINT NOT NULL,
  width       INT,                              -- images/videos
  height      INT,
  duration_ms INT,                              -- videos/voice
  thumb_key   TEXT,                             -- R2 key of thumbnail (null for voice)
  status      TEXT NOT NULL DEFAULT 'processing'
              CHECK (status IN ('processing','ready','failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_media_message ON media (message_id);

-- tags -----------------------------------------------------------------
CREATE TABLE tags (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id     BIGINT NOT NULL REFERENCES chats(id),
  name        CITEXT NOT NULL,                  -- normalized: lowercase, spaces→hyphens
  usage_count INT NOT NULL DEFAULT 0,           -- maintained by trigger or app code
  created_by  BIGINT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, name)
);

CREATE TABLE media_tags (
  media_id   BIGINT NOT NULL REFERENCES media(id),
  tag_id     BIGINT NOT NULL REFERENCES tags(id),
  tagged_by  BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (media_id, tag_id)
);
CREATE INDEX idx_media_tags_tag ON media_tags (tag_id, media_id);  -- the gallery-query index
```

**Tag rules (LOCKED):**
- Normalization on write: trim → lowercase → spaces to hyphens → collapse repeats. Reject empty, >64 chars, or chars outside `[a-z0-9_-]` after normalization. ⚠️ Document the normalization in the UI (small hint text) — silent normalization confuses people (known lesson from Vault's dash→underscore surprise; here we pick hyphens and *say so*).
- Permissions: any chat member may add any tag to any media in that chat; any member may remove any tag. `tagged_by` is attribution, not ownership. It's a trusted circle — shared-wiki semantics, no dispute machinery.
- `usage_count` increments on attach, decrements on detach; suggestion ranking = `ORDER BY usage_count DESC`.

**The gallery query (reference implementation):**
```sql
-- Media in chat :chat_id matching tags [:t1,:t2] excluding [:x1], type filter optional
SELECT m.*
FROM media m
JOIN messages msg ON msg.id = m.message_id AND msg.deleted_at IS NULL
WHERE msg.chat_id = :chat_id
  AND m.status = 'ready'
  AND (:kind IS NULL OR m.kind = :kind)
  -- positive tags: media must have ALL of them
  AND NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY[:t1, :t2]::bigint[]) AS want(tag_id)
    WHERE NOT EXISTS (
      SELECT 1 FROM media_tags mt
      WHERE mt.media_id = m.id AND mt.tag_id = want.tag_id))
  -- negative tags: media must have NONE of them
  AND NOT EXISTS (
    SELECT 1 FROM media_tags mt
    WHERE mt.media_id = m.id AND mt.tag_id = ANY(ARRAY[:x1]::bigint[]))
ORDER BY m.id DESC
LIMIT 60 OFFSET :offset;   -- switch to keyset (WHERE m.id < :cursor) if grids get deep
```
Resolve tag names → ids first (per chat); unknown positive tag ⇒ return empty set immediately (booru behavior).

**Autocomplete query:**
```sql
SELECT name, usage_count FROM tags
WHERE chat_id = :chat_id AND name LIKE :prefix || '%'
ORDER BY usage_count DESC, name ASC
LIMIT 10;
```

---

## 6. API Surface (REST) — sketch

All under `/api`, session-cookie authed except register/login. Keep DTOs in `/shared`.

```
POST /auth/register        {inviteCode, username, displayName, password}
POST /auth/login           {username, password}
POST /auth/logout
GET  /me
-- 🔮 reserved route shapes (do not build in MVP, do not reuse these paths):
-- POST /auth/passkey/register/options   | POST /auth/passkey/register/verify
--                                          (logged-in: add a passkey to account)
-- POST /auth/passkey/login/options      | POST /auth/passkey/login/verify
--                                          (discoverable-credential flow: no username field needed)
-- GET  /auth/oauth/:provider/start      → 302 to provider (full-page redirect,
--                                          NOT popup — popups are flaky in installed PWAs)
-- GET  /auth/oauth/:provider/callback   → session or invite-onboarding handoff
-- POST /auth/identities/:provider/link  | DELETE .../unlink   (settings, logged-in)

GET  /friends              → accepted + pending (in/out)
POST /friends/requests     {username}
POST /friends/requests/:id/accept | /decline

GET  /chats                → list w/ last message, unread count
POST /chats                {memberIds[], name?}  → creates group, or returns existing DM if 1 member
GET  /chats/:id/messages?before=:cursor&limit=50   -- keyset pagination
POST /chats/:id/read       {messageId}

POST /media/uploads        {chatId, kind, mime, sizeBytes} → {mediaId, presignedPutUrl}
POST /media/:id/complete   → server verifies object exists in R2, enqueues processing,
                             creates the message row, returns message
GET  /media/:id/url        → short-lived presigned GET (and thumb URL)

GET  /chats/:id/gallery?q=tag1+tag2+-tag3&kind=image&cursor=...
GET  /chats/:id/tags?prefix=be          -- autocomplete
POST /media/:id/tags       {name}       -- creates tag in registry if new
DELETE /media/:id/tags/:tagId

POST /push/subscribe       {endpoint, keys}
```

⚠️ Every chat-scoped endpoint MUST verify membership (`chat_members` row) — this is the entire authorization model. Write one `assertMember(userId, chatId)` helper and use it everywhere; a missed check here is the app's worst-case privacy bug.

⚠️ Upload validation: enforce max sizes server-side when minting presigned URLs (suggested: images 25 MB, video 500 MB, voice 20 MB), and verify actual object size + sniff content type after upload-complete. Never trust the client's `mime`.

---

## 7. Media Pipeline (the hairy part)

### Upload flow (all kinds)
1. Client: `POST /media/uploads` → gets `mediaId` + presigned PUT.
2. Client PUTs bytes directly to R2 (show progress via XHR/fetch upload events).
3. Client: `POST /media/:id/complete`.
4. Server verifies object (HEAD request to R2: exists, size within declared bounds), creates message row (`kind` = media kind, `status=processing` on media), fans out `message.new` over WS immediately — **receivers see a "processing" placeholder**, not silence.
5. Worker processes → sets `status=ready` → WS `media.ready` event updates the placeholder.

### Per-type processing
| Kind | Server work | Notes |
|------|------------|-------|
| Image | `sharp`: strip EXIF ⚠️ (GPS!), auto-rotate from EXIF orientation first, generate WebP thumb ~400px, record w/h | HEIC from iPhones: Safari on iOS uploads HEIC unless you request JPEG. Accept HEIC and transcode display copy to WebP/JPEG server-side (`sharp` needs libheif — verify on VPS in week 1, fallback: `vips`/ffmpeg). |
| Video | `ffmpeg`: poster-frame thumb (t=0.5s), record duration/dimensions. MVP: **no transcoding**, store original, play native | ⚠️ Codec roulette: iPhone videos (H.264/HEVC in .mov/.mp4) play everywhere-ish; Android may send webm/VP9 which iOS Safari won't play. If it becomes a real problem, add ffmpeg → H.264/AAC MP4 transcode job. Decide by testing real devices in Stage 3, don't pre-build. |
| Voice | Transcode everything to **AAC in .m4a** via ffmpeg (plays natively on iOS + Android + desktop). Record duration. Optional 🔮: waveform peaks JSON for a nice scrubber | ⚠️ THE cursed feature. MediaRecorder gives `audio/mp4` on iOS Safari, `audio/webm;codecs=opus` on Chrome. Normalize server-side to one format; never do format detection at playback time. ⚠️ iOS requires a user gesture to start audio playback and to unlock AudioContext — wire play buttons accordingly. Build the record UI on iOS FIRST, not last. |

### Gallery inclusion
All three kinds appear in the gallery. Type filter tabs: All / Images / Videos / Voice. A searchable, taggable voice-message archive is a genuinely novel feature — treat voice as first-class gallery citizens (row-style list items with duration + tags, not thumbnails).

### R2 hygiene
- Key scheme: `media/{chatId}/{mediaId}/orig.{ext}` and `.../thumb.webp`. Chat-prefixed keys make 🔮 per-chat export/deletion trivial.
- Bucket private; presigned GETs expire ≤ 1 hour; thumbs may use longer expiry.
- Orphan sweep job (weekly cron): delete R2 objects whose `media` row is missing/failed > 7 days.

---

## 8. Realtime & Push

### WebSocket
- One WS connection per client, authenticated by the session cookie during upgrade.
- Server maintains rooms = chat memberships; on `message.new`, emit to room.
- Client behavior on reconnect: refetch messages per open chat since last known id (TanStack Query invalidation) — **do not** try to replay missed WS frames. The DB is the truth; WS is a hint.
- Heartbeat/ping every 25s (proxies kill idle sockets; configure Caddy/nginx `proxy_read_timeout` accordingly).

### Web Push (do this FIRST — Stage 0)
- VAPID keypair in env; `web-push` npm on server.
- Notify chat members who have no active WS connection when a message lands.
- Payload: `{chatId, chatName, senderName, preview}` — keep tiny; deep-link to chat on notification click (service worker `notificationclick` → `clients.openWindow`).
- ⚠️ iOS specifics:
  - Push ONLY works for PWAs **added to home screen**, iOS ≥ 16.4.
  - Permission prompt must be triggered by a user gesture **inside the installed app** — build a "Enable notifications" button in onboarding, don't auto-prompt.
  - Subscriptions churn on reinstall; handle 404/410 responses by deleting the subscription row.
  - Test on a physical iPhone in the first week (borrow the standing iOS beta tester's — see §1 logistics risk). If push doesn't work on iOS, most of the circle has a broken app — this is the project's biggest external risk, so retire it immediately. Android push (your Samsung) is the easy case and does not count as validating this.

---

## 9. Frontend / UI (Instagram-flavored)

### Navigation
- **Bottom tab bar:** Chats · Gallery · Profile. (IG-style; thumb-reachable.)
- Chats tab → chat list → conversation view (IG DM look: bubbles, avatar clusters, media inline).
- Conversation header → tap → chat info → **"Gallery" entry point** (+ members, name).
- Gallery tab (top level) → chats-as-albums grid (cover = latest media thumb) → per-chat gallery.

### Per-chat gallery screen
- 3-column square grid (images/videos w/ duration badge); voice messages listed below grid or shown when Voice filter active.
- Search bar at top: free-text tag query (`beach -screenshots`), chips for active filters, type tabs.
- Tag autocomplete dropdown as-you-type: `name (count)` rows, per-chat registry, keyboard + tap selection.
- Tap media → full-screen viewer: swipe between results (in current filter order), tag list + add-tag UI, "Jump to message" button.

### PWA & platform polish checklist
- [ ] `manifest.webmanifest`: name, icons (512/192 + maskable), `display: standalone`, theme colors for light/dark.
- [ ] Service worker: cache app shell (Vite PWA plugin / Workbox), **network-only for API**, push + notificationclick handlers.
- [ ] `viewport-fit=cover` + `env(safe-area-inset-*)` padding on tab bar and headers — #1 "feels like a website" tell on iOS.
- [ ] Dark mode from day one (CSS variables / Tailwind `dark:`), default to system.
- [ ] Install-instructions screen (detect iOS Safari non-standalone via `navigator.standalone` / display-mode media query): "Share → Add to Home Screen" with pictures.
- [ ] `overscroll-behavior` + `100dvh` (not `100vh`) for the chat view; test keyboard-open layout on iOS (visualViewport API for pinning the composer).
- [ ] Disable double-tap zoom on interactive controls (`touch-action: manipulation`).
- [ ] Skeleton loaders for chat list/gallery; optimistic send for text messages.

⚠️ iOS PWA storage eviction: Safari may wipe origin storage after ~weeks of disuse. Session cookie survives longer than localStorage in practice, but design assuming a cold start: app must fully rebuild from API with zero local state.

---

## 10. Security & Privacy Checklist (MVP honesty edition)

- [ ] argon2id password hashing; rate-limit login + register (fastify-rate-limit).
- [ ] Sessions: httpOnly + Secure + SameSite=Lax; 30-day rolling expiry; logout deletes row.
- [ ] Membership check on EVERY chat-scoped route and WS subscription (§6 ⚠️).
- [ ] Presigned URLs scoped to exact key, short expiry.
- [ ] EXIF/GPS stripped from images on processing (§7).
- [ ] Postgres + R2 access only from VPS; DB not exposed publicly; backups: nightly `pg_dump` to R2 (separate bucket/prefix), test a restore once.
- [ ] Invite codes: generate via admin CLI (`node scripts/invite.ts`), single-use.
- [ ] No third-party JS, no CDN scripts, no analytics. Self-host fonts.
- [ ] Honest model documented to your circle: "I run the server and could technically read messages; E2EE later."
- [ ] CSP headers, and sanitize any user text rendered as HTML (should be none — render as text).

---

## 11. 🔮 Calls — what MVP must do NOW (and nothing more)

Do **not** build any call code. Do preserve these three invariants so calls bolt on cleanly:

1. **DMs are 2-member group chats** (already in schema). 1:1 call = P2P WebRTC, group call = SFU (LiveKit self-hosted when the day comes). The branch point is `chats.is_group`, nowhere else.
2. **WS envelope has reserved type prefixes** (`call.signal.*`, `call.state.*`) — signaling rides the existing socket, no new transport.
3. **TURN awareness:** P2P behind CGNAT/mobile networks will need a TURN server (coturn on the VPS). Don't install it now; just know the VPS will host it.

Anything else call-related that comes to mind during MVP: write it in §13 and walk away.

---

## 12. 🔮 Post-MVP Roadmap (ordered)

1. **Passkeys (WebAuthn) — the headline auth upgrade.** Best fit for the app's ethos: server stores only a public key, nothing phishable, no third party learns anything. Works in installed PWAs on iOS 16+ (iCloud Keychain) and Android (Google Password Manager), syncs across each user's devices automatically. Implementation notes:
   - Library: `@simplewebauthn/server` + `@simplewebauthn/browser` — don't hand-roll CBOR/COSE parsing.
   - Schema is pre-baked (§5 `webauthn_credentials`); routes reserved (§6).
   - Flow: users register with invite code + password as today, then "Add a passkey" from settings (and a post-onboarding nudge). Later, optionally allow passkey-only registration.
   - Use discoverable credentials (`residentKey: 'required'`) so login is one tap, no username typed.
   - Recovery story: passkeys sync via platform keychains, and password login remains as fallback; enforce the ≥1-login-method rule.
   - ⚠️ Re-read the rpID trap in §5 — final domain must be locked before the first passkey exists.
2. **OAuth login (Google) — convenience option, after passkeys.** For the friend who won't set up a passkey and won't trust you with a password. Design pre-baked (§5 `auth_identities`, §6 reserved routes):
   - Authorization Code + **PKCE**, full-page redirect flow (installed-PWA safe on both iOS and Android).
   - Match returning users on `(provider, provider_user_id)` — never on email.
   - Invite codes still gate account *creation*; OAuth only replaces the password.
   - Tradeoff to accept knowingly: Google learns login times/IP for users who choose it. Password login stays available for anyone who cares.
3. **Read receipts + typing indicators** (cheap WS events; `last_read_message_id` already exists).
4. **Message replies/reactions** (add `reply_to_message_id`, `reactions` table).
5. **E2EE v2** — realistic path: libsodium sealed-box per-message encryption with per-chat symmetric keys wrapped per-member (simpler than full Signal/MLS; document the tradeoffs when we get here). Gallery tags/metadata stay server-side plaintext (searchability tradeoff — decide then).
6. **Calls** (§11): 1:1 P2P first, then LiveKit SFU for groups.
7. **Native wrappers** if PWA friction is real: Capacitor APK sideload for Android (trivial for you to install; friends stay on PWA), Tauri for Windows.
8. **Waveforms for voice, video transcoding pipeline, per-chat export/backup.**

## 13. Icebox (ideas parked to protect MVP)
_Add here instead of building. Nothing in this list may be started before §2 is fully checked._
- (empty — keep it that way as long as possible)

---

## 14. Build Order (stages, each independently usable)

**Stage 0 — Risk retirement (week 1):**
- [x] **Lock the final production domain** — `den.ems-place.com`. Future passkeys bind to it permanently (§5 rpID trap). Decided; never move.
- [ ] Repo scaffold (monorepo, Docker Compose, Postgres, Caddy TLS on a subdomain).
- [ ] **Push PoC on a real iPhone:** minimal PWA + service worker + VAPID push. GO/NO-GO gate.
- [ ] **Voice-record PoC on iOS Safari:** MediaRecorder → upload → ffmpeg → m4a → plays back on all platforms.
- [ ] `sharp` + HEIC and `ffmpeg` verified working on the VPS.

**Stage 1 — Auth & identity:**
- [ ] Migration 001 includes `users` (nullable `password_hash`, nullable `email`) **and** `auth_identities` — the OAuth-ready shape ships now even though only passwords are used.
- [ ] Invite-code generation CLI; register/login/logout; session cookie verified working in installed PWA on both Samsung and iPhone.
- [ ] Rate limiting on auth routes; argon2id; account settings stub (display name, avatar).
- [ ] Write the OAuth/passkey plan's assumptions into code comments where they'll matter (login handler, register handler) so future-you doesn't design against them.
- ✅ *Milestone: accounts exist, sessions survive PWA restarts on all three platforms.*

**Stage 2 — Chat core:**
- [ ] Friending (request/accept), DM + group creation.
- [ ] WS envelope + rooms; text messaging with persistence, pagination, reconnect-refetch.
- [ ] Push notifications wired to real messages.
- ✅ *Usable milestone: a working private text chat app.*

**Stage 3 — Media:**
- [ ] Presigned upload flow + progress UI; processing worker; placeholders → ready.
- [ ] Images (EXIF strip, thumbs, HEIC), videos (poster, duration), voice (m4a normalize).
- [ ] Inline rendering in conversation; full-screen viewer.
- ✅ *Usable milestone: chat app with media.*

**Stage 4 — Gallery:**
- [ ] Per-chat gallery grid + type filters; top-level albums page; jump-to-message.
- ✅ *Usable milestone: browsable per-chat media archive.*

**Stage 5 — Tagging & search:**
- [ ] Tag add/remove UI in viewer; registry + autocomplete; normalization + hint text.
- [ ] Query parser (`a b -c`) → gallery query; empty-set on unknown tag; chips UI.
- ✅ *Usable milestone: the full MVP vision.*

**Stage 6 — Polish & ship:**
- [ ] Full §9 PWA checklist on 3 real devices; §10 security checklist; onboarding + install screens.
- [ ] Backups running; invite codes generated; friends onboarded. 🎉

**Rule:** stages ship in order; a stage isn't done until its checklist passes on **your Samsung AND the beta tester's iPhone** (desktop assumed easy, spot-check it). Day-to-day dev happens on Android; the iPhone check is the stage gate. If motivation dies mid-project, every completed stage is still a working app.

---

## 15. Decision Log
| Date | Decision | Why |
|------|----------|-----|
| 2026-07-17 | PWA-only distribution, $0 Apple | iOS 16.4+ Web Push makes it viable |
| 2026-07-17 | DMs = 2-member groups | Clean call-logic split later; no dual code paths |
| 2026-07-17 | Tags per-chat, hyphen-normalized, shared-wiki permissions | Contextual autocomplete; no dispute machinery for a trusted circle |
| 2026-07-17 | Media owned by message | Chat scoping via join; jump-to-message free |
| 2026-07-17 | Booru query = AND + negation only | Covers 95% of use; OR/wildcards are scope creep |
| 2026-07-17 | Voice normalized to m4a/AAC server-side | Only format that plays natively everywhere |
| 2026-07-17 | socket.io over raw ws | Reconnect/rooms are undifferentiated heavy lifting |
| 2026-07-17 | Session cookies over JWT | First-party single-domain; revocation trivial |
| 2026-07-17 | Android (Samsung) = primary dev platform; iOS = first-class guest, gated per stage via a standing beta tester | Dev's daily driver is Android; most users on iPhone; no iPhone owned |
| 2026-07-17 | `auth_identities` table + nullable `password_hash` ship in migration 001 | OAuth (and possibly passkeys) post-MVP without a schema migration; invites authorize, providers authenticate |
| 2026-07-17 | OAuth = full-page redirect + PKCE; match on provider `sub`, never email; no auto-merge by email | Installed-PWA safe; prevents account-takeover-via-email-reuse |
| 2026-07-17 | Passkeys before OAuth; `webauthn_credentials` ships in migration 001; final domain locked in Stage 0 | Best privacy fit (no third party, nothing phishable); rpID binds credentials to domain forever |
| 2026-07-17 | App named **Den**; production domain locked as `den.ems-place.com` | Resolves Stage 0 domain-lock gate; rpID for future passkeys is now fixed |
| | | _(append here as decisions evolve)_ |