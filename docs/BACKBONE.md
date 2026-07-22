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
| 11 | Message deletion | Sender soft-deletes their own message (long-press/`…` → Delete) with a ~10s undo toast; removal fans out over WS to every member's open chat. Multi-select mode (long-press → tap-to-toggle; shift-click ranges on desktop) for bulk delete + copy. **Soft-delete only** — hard wipe is §13 |

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
All three kinds appear in the gallery, split into a Media | Voice segment (BACKBONE §15 2026-07-22 — supersedes the original "Type filter tabs: All / Images / Videos / Voice", which mixed grid tiles and voice rows in one feed). Media is the masonry grid (image OR video, `kind=visual`, with an All/Images/Videos sub-filter); Voice is its own chat-skinned list (`kind=voice`). A searchable, taggable voice-message archive is a genuinely novel feature — treat voice as first-class gallery citizens (chat-style bubbles with duration + tags, not thumbnails).

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

> Shipped as of the UI revamp (`docs/UI_REVAMP.md`, stages UI-1 through UI-8). This section originally described the pre-revamp mobile-only MVP; it now describes what's actually built. Real-device (Samsung/iPhone) verification remains a standing gate per stage — see `docs/UI_REVAMP.md` §6/§7/§8 for what's confirmed vs. still pending.

### Navigation
- **Mobile (`useIsMobile()`, ≤768px):** bottom tab bar, Chats · Gallery · Profile, one `View` rendered full-screen at a time — the original IG-style thumb-reachable nav, unchanged in spirit from the original plan.
- **Desktop (>768px):** left icon rail (same three destinations) replaces the bottom tabs; the Chats tab becomes dual-pane (fixed ~360px conversation list + active chat filling the rest), so list and open chat are visible simultaneously. Gallery and Profile stay single-pane on both layouts — no natural second pane for either. Friends/New Group render as a full-screen push on mobile, a centered overlay (list pane still mounted behind it) on desktop.
- Chats tab → chat list → conversation view (IG DM look: asymmetric-tail bubbles, media inline, pill composer with circular icon buttons).
- Conversation header → **"Gallery" entry point** (+ members, name) opens that chat's gallery.
- Gallery tab (top level) → chats-as-albums grid (cover = latest media thumb, responsive column count) → per-chat gallery.
- Design tokens (`app/src/index.css`: surface/text/border/accent/radius/shadow custom properties, dark mode via `prefers-color-scheme`) and `lucide-react` icons (no more emoji) back every screen; `ScreenHeader` is the one shared header component.
- **System back gesture / browser back** (`app/src/lib/backStack.tsx`, `BackStackProvider` + `useBackHandler`): the router-less view stack and overlays are bridged to the History API so the device back gesture pops one app layer at a time instead of unwinding out of the PWA to a blank page. Mechanism is the classic PWA "single trap, always re-armed" — one history entry kept on top at all times and re-pushed on *every* `popstate`; each back press pops the topmost registered handler (LIFO) and re-arms. Open overlays (MediaViewer, message focus menu) and selection mode close first, then the view unwinds via `parentOf` (App.tsx): chat/friends/new-group/gallery/profile → Chats, chat-gallery → Gallery, Chats is the true root. Root back (no handler) is an inert re-arm — never a blank page, never exits the PWA. ⚠️ iOS standalone edge-swipe fires `popstate` and should work, but is unverified on real hardware — on the iOS testing checklist.

### Chat interaction pass (UI-8)
- **Send/receive animation:** a freshly-sent or freshly-arrived bubble eases in (small scale-up + slide-up + fade, ~180ms); already-loaded history never animates. Degrades to instant under `prefers-reduced-motion`.
- **Run corners:** bubbles within a run flatten their *inner* sender-side corners (head/middle/tail-aware), so a burst of same-sender messages reads as one connected column; the run's last bubble keeps the small tail nub it always had.
- **Date/time dividers:** a centered muted label between runs — a date ("Yesterday" / weekday / "MMM D") at a calendar-day boundary, a time ("4:23 PM") for a same-day gap over an hour. Purely derived from whatever's currently loaded, recomputed on pagination.
- **Desktop hover action bar:** three-icon row next to a bubble on hover — More (opens the focus menu), Reply, React. **Reply and React are inert placeholders** — see §13.
- **Focus menu (replaces the old bottom sheet):** tapping/clicking a message (long-press on mobile, the hover bar's "More" on desktop) lifts the bubble in place, dims + blurs the background, and drops a Copy/Select/Delete panel (plus the message's send time) below or above it. Never edge-to-edge; dismisses on backdrop tap, Escape, or an action.
- **Recording UX:** pressing the mic morphs the composer into a live-waveform recording bar with an elapsed timer. Mobile: hold-to-record, slide-up-to-lock (hands-free), slide-left-to-cancel. Desktop: click to start, explicit Stop/Cancel buttons. Same upload/transcode path as before (§7) — only the trigger UI changed.

### Per-chat gallery screen
- Hand-rolled masonry grid (images/videos w/ duration badge) — shortest-column packing, aspect ratio predicted from `MediaInfo.width`/`height` (no image-load pop-in, no CSS `column-count`), column count derived from the gallery pane's actual measured width via `ResizeObserver` rather than a fixed 3-column layout; voice messages listed as a separate row list below the grid (never a thumbnail).
- Search bar at top: free-text tag query (`beach -screenshots`), chips for active filters, type tabs.
- Tag autocomplete dropdown as-you-type: `name (count)` rows, per-chat registry, keyboard + tap selection.
- Tap media → full-screen viewer (`MediaViewer`): desktop arrow buttons **and** hand-rolled touch gestures both navigate the current filter-ordered result set — swipe left/right for prev/next, swipe down to close, pinch and double-tap to zoom/pan on images (raw Pointer Events, no gesture library; video items keep native `controls` and arrow-button/tap-outside navigation only — see `docs/UI_REVAMP.md` UI-6 notes for why gestures weren't layered onto video). Tag list + add-tag UI, "Jump to message" button.

### PWA & platform polish checklist
> Box state audited against the code 2026-07-21. These were built during Stages 3–5 and the UI revamp but never checked off — the boxes had rotted, they weren't open work.

- [x] `manifest.webmanifest`: name, icons (512/192 + maskable), `display: standalone`, theme colors for light/dark. — `app/vite.config.ts` (`VitePWA.manifest`) + `app/public/icons/` (192, 512, maskable-512, apple-touch-icon). ⚠️ _One `theme_color` (`#0b0b0f`) covers both schemes rather than a light/dark pair._
- [x] Service worker: cache app shell (Vite PWA plugin / Workbox), **network-only for API**, push + notificationclick handlers. — `app/src/sw.ts` via `injectManifest` (custom SW precisely so push/notificationclick could be hand-written); API + WS explicitly never cached.
- [x] `viewport-fit=cover` + `env(safe-area-inset-*)` padding on tab bar and headers — #1 "feels like a website" tell on iOS. — `app/index.html` viewport meta; insets applied in `App.tsx` (bottom nav, headers, side rail).
- [x] Dark mode from day one (CSS variables / Tailwind `dark:`), default to system. — design tokens in `app/src/index.css`, `prefers-color-scheme`.
- [x] Install-instructions screen (detect iOS Safari non-standalone via `navigator.standalone` / display-mode media query): "Share → Add to Home Screen" with pictures. — `app/src/components/InstallInstructions.tsx` + `app/src/lib/pwa.ts`. ✅ _Path exercised for real on 2026-07-21 (iPhone install)._
- [~] `overscroll-behavior` + `100dvh` (not `100vh`) for the chat view; test keyboard-open layout on iOS (visualViewport API for pinning the composer). — `overscroll-behavior: none` (`index.css`) and `100dvh` throughout `App.tsx` are done. ⚠️ _**No `visualViewport` usage anywhere in `app/src`** — the composer is not pinned against the iOS software keyboard. This is the one genuinely-unbuilt item in this list._
- [x] Disable double-tap zoom on interactive controls (`touch-action: manipulation`). — `app/src/index.css:103`.
- [~] Skeleton loaders for chat list/gallery; optimistic send for text messages. — optimistic send done (`app/src/lib/realtime.tsx`). ⚠️ _No skeleton loaders exist; list/gallery loading states are plain._

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
4. ✅ **Message replies/reactions** — **shipped 2026-07-22, pulled forward out of order** (owner's call once MVP was verified complete on real iOS; see §15). Landed `messages.reply_to_message_id` + a `message_reactions` table (migration 005), a denormalized `ReplyPreview` snapshot and aggregated `ReactionSummary[]` on the `Message` DTO, swipe-to-reply + double-tap-to-react + a quick-emoji row, and `reaction.added`/`reaction.removed` WS types.
5. **E2EE v2** — realistic path: libsodium sealed-box per-message encryption with per-chat symmetric keys wrapped per-member (simpler than full Signal/MLS; document the tradeoffs when we get here). Gallery tags/metadata stay server-side plaintext (searchability tradeoff — decide then).
6. **Calls** (§11): 1:1 P2P first, then LiveKit SFU for groups.
7. **Native wrappers** if PWA friction is real: Capacitor APK sideload for Android (trivial for you to install; friends stay on PWA), Tauri for Windows.
8. **Waveforms for voice, video transcoding pipeline, per-chat export/backup.**

## 13. Icebox (ideas parked to protect MVP)
_Add here instead of building. Nothing in this list may be started before §2 is fully checked._
- **Hard-wipe of deleted messages (purge-after-timer).** Owner-facing "Deleted" page + a retention timer (~15 min was the original sketch), after which the row is *actually removed from Postgres* rather than left as a `deleted_at` tombstone. Wanted for real: the privacy-first premise of the app means "deleted" should eventually mean gone, not hidden. Deliberately parked because the cost is structural, not cosmetic:
  - Needs the **first background job in the codebase** — there is no scheduler, cron, or queue anywhere in `server/src` today (the 2026-07-20 decision log entry chose inline media processing specifically to avoid queue infra).
  - Deleting a message that owns media is a **cascade across two stores with no shared transaction**: `media.message_id` is `NOT NULL REFERENCES messages(id)`, so it means dropping the `media` row + its `media_tags` rows, decrementing each tag's `usage_count`, *and* deleting the orig + thumb objects from R2. Partial-failure states are real and need a reconciliation story (the §7 orphan sweep is the natural place to hang it).
  - Contradicts hard invariant 8 ("Soft deletes only; never hard-delete rows in MVP") — needs an explicit, logged override when it ships.
- ~~**Message replies + reactions**~~ — **BUILT 2026-07-22** (see §12.4 and §15). The UI-8 seams (hover Reply/React buttons, focus menu) that were inert placeholders are now wired: reply state + quoted-message render + swipe-to-reply, and reactions storage (`message_reactions`) + double-tap-to-react + a quick-emoji row + reaction pills. No longer iceboxed.
- **Voice bubbles joining gallery multi-select, and any bulk action beyond tagging.** Stage 5 of the gallery rework (BACKBONE §15 2026-07-22) scoped selection mode to the Media segment only — voice rows keep their existing per-item inline `TagEditor`, unchanged. Extending long-press/ctrl-click selection to voice rows, and any bulk action beyond batch tag add/remove (bulk delete, download, share, move) in either segment, is parked here rather than built now — the agreed brief was tagging-only for Media.

---

## 14. Build Order (stages, each independently usable)

**Stage 0 — Risk retirement (week 1):**
- [x] **Lock the final production domain** — `den.ems-place.com`. Future passkeys bind to it permanently (§5 rpID trap). Decided; never move.
- [x] Repo scaffold (monorepo, Docker Compose, Postgres, Caddy TLS on a subdomain). Built + typecheck/lint/build green. See `docs/STAGE0.md`.
- [x] **Push PoC on a real iPhone:** minimal PWA + service worker + VAPID push. GO/NO-GO gate. ✅ _**GO** — verified 2026-07-21 on a physical iPhone against prod: notifications arrive on the installed PWA, and the Safari → Add to Home Screen install presents correctly as an app._
- [x] **Voice-record PoC on iOS Safari:** MediaRecorder → upload → ffmpeg → m4a → plays back on all platforms. ✅ _Verified 2026-07-21 on a physical iPhone against prod — record → upload → transcode → playback round-trip works. The `audio/mp4`-from-iOS input path is confirmed real, not just assumed._
- [~] `sharp` + HEIC and `ffmpeg` verified working on the VPS. _`ffmpeg` **confirmed** on the prod VPS — the 2026-07-21 iPhone voice round-trip above transcodes through it server-side, so it's proven in place. `sharp` + **HEIC decode is still untested**: no iPhone camera photo (the only common HEIC source) has been uploaded to prod yet._

**Stage 1 — Auth & identity:**
- [x] Migration 001 includes `users` (nullable `password_hash`, nullable `email`) **and** `auth_identities` (+ `webauthn_credentials`, `invite_codes`, `sessions`, `push_subscriptions`) — the OAuth/passkey-ready shape ships now even though only passwords are used. Applied to Postgres; citext enabled.
- [x] Invite-code generation CLI (`npm run invite create`); register/login/logout; session cookie. Verified end-to-end locally (API + Vite proxy). ⚠️ _Installed-PWA session persistence on Samsung/iPhone still needs a device pass (no iPhone yet — deferred with the push/voice gates)._
- [x] Rate limiting on auth routes (10/min); argon2id (`@node-rs/argon2`); account settings stub (display name; avatar deferred to R2/Stage 3).
- [x] OAuth/passkey assumptions written into `routes/auth.ts` header + inline (invites authorize / providers authenticate; match on `(provider, provider_user_id)`; ≥1 login method; reserved paths untouched).
- ✅ *Milestone: accounts exist, sessions survive server restarts; login is case-insensitive with no username enumeration. Device-side PWA-restart check pending hardware.*

**Stage 2 — Chat core:**
- [x] Friending (request/accept), DM + group creation. Friendship gates DMs and group adds (`areFriends` check in `chat/service.ts createChat`).
- [x] WS envelope + rooms; text messaging with persistence, pagination, reconnect-refetch. `user:{id}` + `chat:{id}` socket.io rooms; cookie-authed handshake; keyset pagination on `messages(chat_id, id DESC)`.
- [x] Push notifications wired to real messages. `push_subscriptions` persisted per user; `notifyChatMembers` pushes to members with no live socket in the chat's room (§8 "no active WS connection").
- Verified end-to-end locally: REST (friend request/accept, DM idempotency, group creation, pagination, read receipts/unread counts) + WS (cookie auth, room fanout, dynamic room-join on `chat.created` for members already connected when a chat is created) via curl + a socket.io-client script, three-account (alice/bob/carol) DM + group scenarios. Full typecheck/lint/build green.
- 🐛 *Found + fixed during Stage 3 manual testing (2026-07-20): `POST /chats` only joined the **new members'** live sockets to the fresh chat room, never the **creator's own** socket. Symptom: the creator's own sent messages never echoed back to them (optimistic bubble stuck gray forever) and replies from the other member didn't arrive live — both required a refresh (reconnect re-joins all current rooms) to show up. Fixed in `routes/chats.ts` by including the creator in the room-join loop; regression-verified with two live sockets exchanging messages on a freshly created DM, no reconnect needed.*
- ⚠️ *Real-device pass (Samsung + iPhone) still pending — same hardware gate as Stage 0/1.*
- ✅ *Usable milestone: a working private text chat app.*

**Stage 3 — Media:**
- [x] Presigned upload flow + progress UI (`POST /media/uploads` → PUT → `POST /media/:id/complete`); processing runs inline post-complete, not a queue (closed-circle volume doesn't warrant one). Placeholder message fans out over WS immediately (`message.new`, media.status='processing'); `media.ready` follows once processing finishes.
- [x] Images: sharp — EXIF/GPS strip (`.rotate()` then no `withMetadata()`), auto-rotate, re-encode to WebP + 400px WebP thumb. HEIC decodes via sharp's bundled libvips (`heif: 1.18.2` — verified locally; Dockerfile.api also installs system `libvips` for the VPS).
- [x] Videos: ffmpeg poster frame (t=0.5s) + ffprobe duration/dimensions; no transcode in MVP (original kept as-is).
- [x] Voice: ffmpeg → mono 48kHz AAC/m4a (same normalization as the Stage 0 PoC).
- [x] Upload validation: per-kind size ceilings enforced at mint time; HEAD-verified size + magic-number content sniffing (`file-type`) at complete time — a mislabeled upload (wrong `kind` for the actual bytes) is rejected before processing (CLAUDE.md hard invariant 7).
- [x] Inline rendering in ChatView (image/video bubbles with tap-to-expand, voice as an inline player) + `MediaViewer` full-screen overlay for image/video.
- [x] Local dev storage: MinIO in docker-compose stands in for R2 (same S3-compatible client code; `server/src/media/r2.ts`). Swapping to real R2 for prod is an env-var change only.
- Verified locally: full upload→process→download round-trip via a scripted 2-account flow for all three kinds:
  - **image** — WebP re-encode + thumb + presigned GET download confirmed byte-for-byte fetchable, EXIF stripped.
  - **voice** — a real synthesized WAV, transcoded by a real ffmpeg (Docker Compose `api` image, `ffmpeg 5.1.9`) to AAC/m4a; downloaded output verified as a valid `ftypM4A` container with correct probed duration.
  - **video** — a real ffmpeg-generated H.264 test clip processed end-to-end: correct width/height/duration via ffprobe, valid JPEG poster frame at t=0.5s, original bytes preserved and downloadable.
  - Also confirmed: sniffing rejection (PNG bytes uploaded as kind='video' → 400 before processing ever runs), and a processing failure (missing ffmpeg, before the Docker fix below) flips `media.status='failed'` cleanly without crashing the server or the placeholder message.
- 🐛 *Two infra bugs found and fixed while wiring up Docker Compose for this verification pass (both in `deploy/docker-compose.yml`, neither affects prod since prod's `.env` never sets the host-dev-oriented values that triggered them):*
  1. *`NODE_ENV` and `R2_ENDPOINT` in the `api` service's environment inherited directly from the shared root `.env` — which is tuned for the host `npm run dev` workflow (`NODE_ENV=development`, `R2_ENDPOINT=http://localhost:9000`). Inside the container those values crash-loop the process (dev-only `pino-pretty` isn't installed in the prod image) and point R2 calls at an unreachable host. Fixed with container-only override vars, `API_NODE_ENV` and `API_R2_ENDPOINT`, decoupled from the shared `.env` keys.*
  2. *Presigned URLs were signed against the internal `R2_ENDPOINT` (`http://minio:9000`, only reachable from inside the docker network) and then had their host rewritten to `R2_PUBLIC_ENDPOINT` for the browser — but SigV4 signs the Host header, so rewriting it after signing produces `SignatureDoesNotMatch`. Fixed in `server/src/media/r2.ts`: a dedicated signing-only `S3Client` configured with the public endpoint (safe — `getSignedUrl` never makes a network call, so the client doesn't need to actually reach that host), used only by `presignPut`/`presignGet`. The operational client (`s3`, used for HEAD/GET/PUT the server does itself) keeps the internal endpoint. In prod both endpoints are the same public R2 host, so this is a no-op there.*
- ⚠️ *Real-device pass (Samsung + iPhone) still pending — same hardware gate as Stage 0/1/2. HEIC-from-iPhone and iOS voice record are the two highest-risk items here.*
- ✅ *Usable milestone: chat app with media.*

**Stage 4 — Gallery:**
- [x] Per-chat gallery: `GET /chats/:id/gallery?kind=&before=&limit=` — status='ready' media only, keyset-paginated on media id DESC, optional type filter. 3-column grid for images/videos (video tiles show a play glyph over the poster thumb); voice listed separately as inline-player rows (never a thumbnail, per §7/§9). Type filter tabs: All/Images/Videos/Voice.
- [x] Top-level albums page: `GET /gallery/albums` — every chat with ≥1 ready media item, cover = latest item's thumb, chats with zero media omitted. New "Gallery" bottom tab (nav is now 3 tabs — supersedes the Stage 2 decision-log note that it'd stay 2 until this stage).
- [x] Jump-to-message: from a gallery grid tile (via the full-screen `MediaViewer`, which also gained prev/next arrows to step through the current filtered result set) or a voice row, navigates to the chat and auto-pages older history until the target message loads, then scrolls it into view with a brief highlight.
- Verified locally: scripted 2-account flow — 3 images uploaded to a chat, `/gallery/albums` returns the right cover + `mediaCount`, `/chats/:id/gallery` pagination (`limit`/`before`) and `?kind=` filtering both correct; a non-member registered fresh got a 403 on the per-chat gallery and the chat never appeared in their `/gallery/albums` list (membership enforcement holds — CLAUDE.md hard invariant 1). Full typecheck/lint/build green.
- ⚠️ *Real-device pass (Samsung + iPhone) still pending — same standing gate as prior stages. Grid/viewer touch interactions (tap-to-open, prev/next arrows vs. true swipe) haven't been felt on an actual touchscreen yet.*
- ✅ *Usable milestone: browsable per-chat media archive.*

**Stage 5 — Tagging & search:**
- [x] Migration 004: `tags` + `media_tags`. Normalization (trim → lowercase → spaces→hyphens → collapse; charset `[a-z0-9_-]`, ≤64 chars) lives in `shared/src/tags.ts` so client and server apply the identical transform — the input placeholder text hints it live rather than normalizing silently (CLAUDE.md hard invariant 5).
- [x] Shared-wiki permissions: any chat member adds/removes any tag; `tagged_by` is attribution only. Re-tagging something already tagged is a no-op (doesn't double `usage_count`); a concurrent same-tag creation race is handled (insert-then-reselect).
- [x] `GET /chats/:id/tags?prefix=` autocomplete (ranked by usage then name); `POST /media/:id/tags` / `DELETE /media/:id/tags/:tagId`; `WsType.TagAdded`/`TagRemoved` broadcast to the chat room so every open gallery/viewer stays in sync without a refetch.
- [x] Booru query parser (`shared/src/tags.ts` `parseTagQuery`) wired into `GET /chats/:id/gallery?q=`: AND on positive tags, NOT on negated (`-tag`) ones; an unresolvable positive tag returns an empty page immediately rather than hitting the media table at all (§5 booru behavior).
- [x] Tag list + add/remove UI with autocomplete dropdown in the full-screen `MediaViewer` (images/videos) and inline for voice rows (expandable, since voice has no viewer). Search bar at the top of `ChatGallery` for the free-text query.
- [x] **Gallery rework stage 5 — multi-select batch tagging (`app/src/components/ChatGallery.tsx`, BACKBONE §15 2026-07-22):** Media segment only. Mobile enters selection via long-press on a tile (same 500ms/10px timing as `ChatView`'s message multi-select); desktop via a "Select" toggle button in the sub-filter row or ctrl/cmd-click on a tile. While selecting, plain tap/click toggles membership and the full-screen viewer is unreachable (mutually exclusive with selection mode, same as `ChatView`'s selection-vs-viewer split). Exits via an explicit X, device/browser back (`useBackHandler`, same LIFO pattern as `ChatView`), or deselecting the last item. A tag panel appears whenever the selection is non-empty — desktop: a ~320px right-side panel (full height of the content area, own scroll, mini-grid of selected thumbnails); mobile: a bottom sheet (thumbnail strip + `TagEditor`, `env(safe-area-inset-bottom)`-padded, with an expand affordance for a large tag set). Both reuse `TagEditor` unmodified against the *intersection* of the selected items' tags — adding a tag applies it to every selected item, removing a chip removes it from every selected item, batched as a client-side `Promise.allSettled` loop over the existing per-media `addTag`/`removeTag` endpoints (no new batch API surface) followed by the standard `['gallery']` query invalidation so refreshed server data (not local state) drives the next intersection. Voice bubbles keep their existing per-item inline editor unchanged — joining them to selection is Icebox (§13).
- ⚠️ *Deviates from §5's literal reference SQL: the positive-tag "has ALL of these" match uses one `EXISTS` clause per required tag (ANDed) instead of the documented `unnest(...)::bigint[]` form — postgres.js/drizzle's `sql` template doesn't cleanly bind a JS array to a `::bigint[]` cast (`cannot cast type record to bigint[]`) found while self-testing. Same semantics, different SQL shape; negative-tag exclusion still uses `sql.join` to build an `IN (...)` list. Documented in `server/src/media/gallery.ts`.*
- Verified locally: scripted 2-account flow covering normalization (`"  Beach Trip  "` → `beach-trip`), shared-wiki tagging by a different member, idempotent re-tag (no double-count), invalid-name rejection (400), autocomplete, AND query, negation query, unknown-tag → empty set, tag removal reflected in a subsequent query. Full typecheck/lint/build green.
- ⚠️ *Real-device pass (Samsung + iPhone) still pending — same standing gate as prior stages. The gallery multi-select addition above is untested on real touch hardware: long-press timing/slop feel (shared code path with `ChatView`'s already-flagged multi-select, so likely the same verdict once one is tested), the mobile bottom sheet's safe-area padding on a notched device, and whether the sheet's un-capped compact height ever visually collides with the grid content below it on a small viewport.*
- ✅ *Usable milestone: the full MVP vision.*

**Stage 6 — Polish & ship:**
- [~] Full §9 PWA checklist on 3 real devices; §10 security checklist; onboarding + install screens.
  - [x] §9 checklist **audited against the code** (2026-07-21) — everything is built except `visualViewport` keyboard pinning and skeleton loaders; boxes above were rotted, not open.
  - [x] Install screen / Add to Home Screen — exercised on a real iPhone (2026-07-21).
  - [~] **Real-device pass.** iPhone (installed PWA, against prod, 2026-07-21): **push notifications ✅, voice record + playback ✅, install/app presentation ✅.** Still unverified on iOS: HEIC photo upload, session persistence across PWA cold starts, gallery/`MediaViewer` touch gestures (incl. the guessed 56px video-controls exclusion zone), keyboard-open composer layout. Samsung + desktop passes still outstanding.
  - [ ] §10 security checklist; onboarding screens.
- [x] **§2 item 11 — message deletion + multi-select** (`docs/MESSAGE_DELETE.md`). Soft-delete only, no migration: `POST /chats/:id/messages/delete` + `.../restore`, `message.deleted` (ids) / `message.restored` (full DTOs) batched over the chat room, ~10s client undo toast, long-press action sheet + selection mode (tap-toggle, desktop shift-click ranges).
  - Verified against a from-source server + real Postgres with a scripted 2-account socket test — **24/24 green**: ownership 403s (other's message, mixed batch, nonexistent id, non-member), batch-size 400s, single + bulk delete fanout reaching *both* sockets, one batched frame for a 3-message bulk delete (not 3), idempotent re-delete broadcasting no phantom frame, restore carrying full message bodies, and the chat-list preview falling back to the newest survivor. Confirmed in `psql` that all rows survive with only `deleted_at` set (CLAUDE.md #8) — nothing hard-deleted, no R2/media/tag rows touched.
  - 🐛 *Found in review, fixed before commit: `MediaBubble` puts its `onClick` on the inner `<img>`/`<div>`, which fires **before** the wrapper's click-suppression check (target before ancestor). A long-press on an image therefore opened the full-screen `MediaViewer` on top of the action sheet. `openViewer` now re-checks the same suppression flag. A stale-flag case was closed alongside it (long-press followed by a pointer-lift off the bubble produces no click, so the flag was never reset and silently swallowed the next tap).*
  - ⚠️ *Everything touch-side is unverified on hardware: long-press timing/slop feel, the iOS native-callout suppression, action-sheet safe-area padding on a notched device, and long-press vs. the `MediaViewer` gesture layer on media bubbles. Goes on the standing iPhone/Samsung gate.*
- [~] Backups running; invite codes generated; friends onboarded. 🎉
  - [x] **Backups**: nightly `pg_dump -Fc` → R2 under a `backups/` prefix, retention clamped to `BACKUP_KEEP` (default 7) by the uploader itself rather than a separate cleanup job. `deploy/backup.sh` + `server/src/scripts/backup.ts` + a systemd timer (`deploy/systemd/`). Runs through the existing containers — dump from the `postgres` image, upload from the `api` image, which already has the R2 credentials — so no new host tooling and no second copy of the keys. Dumps are size-checked **and** `pg_restore --list`-validated before upload, since a truncated dump is worse than none.
  - [ ] **Restore drill** — untested until a dump is actually restored into a throwaway DB (`deploy/README.md` "Restoring"). Until then this is a hypothesis, not a backup.
  - [ ] Invite codes generated; friends onboarded.

> **Standing device-gate status (2026-07-21).** The per-stage ⚠️ "real-device pass pending" notes in Stages 1–5 above are now *partially* retired: the iOS platform risks that were flagged as highest-danger (Web Push actually firing on an installed iOS PWA, and iOS `MediaRecorder` → ffmpeg → m4a playback) are **confirmed working on real hardware against prod**. What remains is breadth, not existential risk — HEIC decode, touch-gesture feel, and cold-start session persistence.

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
| 2026-07-17 | Password hashing via `@node-rs/argon2` (argon2id) | Prebuilt binaries → clean installs on Windows dev + Linux Docker, no node-gyp |
| 2026-07-17 | Session cookie `Secure` is prod-only; migration 001 = auth tables only (chat tables deferred to Stage 2) | Secure cookies are dropped over http://localhost, would break dev; keeps stage ordering |
| 2026-07-17 | Compose Postgres publishes on `127.0.0.1:${POSTGRES_HOST_PORT}` (localhost-only) | Host-side drizzle-kit/psql/debugging reach it without exposing DB publicly (§10) |
| 2026-07-17 | Friend accept/decline routes address the *other user's id* (`POST /friends/requests/:userId/accept`), not a synthetic request id | `friendships` PK is the `(user_a, user_b)` pair (§5 DDL has no surrogate id column); a pair has at most one relationship at a time, so the other user's id is already a unique, stable handle |
| 2026-07-17 | Sending a friend request to someone who already has a pending request in to you auto-accepts instead of erroring | Mutual interest — both people trying to add each other should just become friends, not hit a dead-end asking one of them to go find the other's request |
| 2026-07-17 | WS rooms: `chat:{id}` (message fanout) + `user:{id}` (chat-agnostic notices: `chat.created`, `friend.request`, `friend.accepted`) | §8 only specifies chat-membership rooms for messages; the `user:` room is a natural extension — "just more type values," no new transport — so a newly-created chat or friend event reaches an already-connected client without a refetch |
| 2026-07-17 | Bottom nav is 2 tabs (Chats, Profile) for Stage 2; Friends is a header button inside Chats, not a tab | Gallery (§9's third tab) doesn't exist until Stage 4 — avoids a nav redesign later; add Gallery as the third tab then |
| 2026-07-20 | Media processing runs inline (in-process, right after upload-complete verifies the object) instead of a job queue | Closed friend-circle volume doesn't justify queue infra; §14 never called for one. Revisit only if processing latency becomes a real UX problem |
| 2026-07-20 | Local dev object storage is MinIO (docker-compose service), not a real R2 dev bucket | Same S3-compatible client code as prod R2 (`server/src/media/r2.ts`); lets Stage 3 be built and self-tested end-to-end without waiting on Cloudflare account setup. Prod swap is env vars only (`R2_ENDPOINT` etc., `.env.example`) |
| 2026-07-20 | Image/voice uploads are re-encoded and the raw original is deleted from R2 after; video keeps its original (no re-encode in MVP) | Avoids paying to store both the raw upload and the derived asset forever for kinds that always transcode; video has no derived copy to prefer, so nothing to delete |
| 2026-07-20 | `media.message_id` NOT NULL (§5 DDL) is satisfied by creating the `messages` row inside `createUpload` (before the file is even PUT to R2), but the WS `message.new` fanout is deferred to `completeUpload` | Reconciles the DDL's NOT NULL FK with §7's "server creates message row and fans out at complete-step" flow; means an abandoned upload (client never calls complete) leaves an orphan processing-status row — acceptable for MVP, same class of edge case as the existing §7 orphan-sweep job |
| 2026-07-20 | Fixed: chat creation now joins the creator's own live socket to the new chat room, not just the other member's | Stage 2 bug found in Stage 3 manual testing — creator's own messages never echoed back live (stuck as gray pending bubbles) and replies needed a refresh to appear; `routes/chats.ts` room-join loop was missing `req.user!.id` |
| 2026-07-20 | R2 presigning uses a separate `S3Client` configured with the browser-reachable endpoint, distinct from the operational client the server uses for its own HEAD/GET/PUT calls | SigV4 signs the Host header — signing against an internal-only endpoint (docker's `minio:9000`) then rewriting the host for the browser breaks the signature (`SignatureDoesNotMatch`). A signing-only client never needs to actually reach the host it's configured with, since `getSignedUrl` makes no network call. No-op in prod (both endpoints are the same public R2 host) |
| 2026-07-20 | `docker-compose.yml`'s `api` service env uses `API_NODE_ENV`/`API_R2_ENDPOINT` overrides instead of reading `NODE_ENV`/`R2_ENDPOINT` straight from the shared root `.env` | Those two keys in `.env` are tuned for the host `npm run dev` workflow (`development`, `localhost:9000`) and crash-loop or misconfigure the container if inherited directly — decoupling them lets one `.env` serve both workflows |
| 2026-07-20 | Bottom nav becomes 3 tabs (Chats, Gallery, Profile) as of Stage 4 | Matches §9's original nav spec now that Gallery exists; supersedes the Stage 2 decision-log note that it'd stay 2 tabs until this stage landed |
| 2026-07-20 | Gallery viewer uses prev/next arrow buttons to step through the current filtered result set, not a swipe gesture | Functionally equivalent for stepping through results and far less code/risk than hand-rolled touch-swipe detection; revisit only if real-device testing shows arrows feel wrong on a touchscreen |
| 2026-07-20 | `chatDisplayName`'s parameter type narrowed to `Pick<ChatSummary, 'name'\|'isGroup'\|'members'>` instead of full `ChatSummary` | `GalleryAlbum` has the same three fields but isn't a `ChatSummary` (no `id`/`avatarUrl`/`lastMessage`/etc.) — the narrower type lets gallery screens reuse the same display-name logic instead of duplicating it |
| 2026-07-20 | Gallery tag-query positive matching uses one `EXISTS` clause per required tag (ANDed) instead of §5's documented `unnest(...)::bigint[]` reference SQL | postgres.js/drizzle's `sql` template doesn't cleanly bind a JS array to a `::bigint[]` cast (`cannot cast type record to bigint[]`, found in local testing); same semantics, avoids fighting the driver |
| 2026-07-20 | `tag.added`/`tag.removed` WS handlers invalidate all `['gallery']` queries broadly rather than targeting the specific chat | The payload only carries `mediaId`, not `chatId`; react-query only refetches queries that are actually mounted, so the broad invalidation is cheap and keeps every open gallery/viewer in sync with shared-wiki tag edits |
| 2026-07-20 | UI revamp (`docs/UI_REVAMP.md`, UI-1 through UI-6) ships hand-rolled swipe/pinch/double-tap gestures in `MediaViewer`, superseding the Stage-4 decision that arrow buttons alone were sufficient | Desktop-only arrow-button nav was accepted for MVP shipping speed, with an explicit note to "revisit only if real-device testing shows arrows feel wrong on a touchscreen" — the UI revamp project (design tokens, responsive shell, masonry gallery, gesture-driven viewer) was the planned point to revisit it. Arrow buttons are kept alongside the new gestures, not replaced, since desktop mouse users still benefit from them |
| 2026-07-20 | `MediaViewer`'s new Pointer-Event gesture layer (swipe/pinch/double-tap) is scoped to `<img>` only — `<video>` keeps native `controls` and arrow-button/tap-outside navigation, no custom gestures | Custom `setPointerCapture`-based gestures on the same element as native video `controls` risk hijacking the browser's own scrubber/play/fullscreen touch surface, and that specific interaction can't be verified without real touch hardware; preserving existing video-control behavior exactly was judged more important than gesture parity with images for this stage. Logged as an open gap in `docs/UI_REVAMP.md` §8, revisit after real-device testing |
| 2026-07-20 | Video gesture gap (previous entry) closed: `<video>` in `MediaViewer` now gets swipe-left/right (prev/next) and swipe-down-to-close, reusing image's exact thresholds via a shared pure `resolveSwipeGesture()` helper, gated by checking the pointerdown's Y position against a bottom exclusion zone (`VIDEO_CONTROLS_EXCLUSION_HEIGHT = 56px`) before arming any gesture tracking | A pointerdown inside the exclusion zone is left completely untouched (no `setPointerCapture`, no tracking, no `preventDefault`), so native controls-bar touches (scrubber/play/fullscreen) get a fully unmodified event stream, addressing the risk the previous entry flagged. Pinch-zoom/double-tap-zoom remain deliberately out of scope for video (never asked for, doesn't fit alongside native playback controls). The 56px exclusion height is a judgment call, not a measurement — stays unverified until the real-device pass; see `docs/UI_REVAMP.md` §8 |
| 2026-07-21 | Stage 0's two iOS GO/NO-GO gates are **GO**, verified on a physical iPhone (installed PWA) against prod, not locally: Web Push delivers, and iOS voice record → upload → ffmpeg → m4a → playback round-trips | These were the project's two existential platform risks (§1: "most users on iPhone, and you don't own one") and had been open since week 1, blocking every stage's ⚠️ device note. Retiring them converts the remaining device work from "might invalidate the architecture" to "breadth testing". Also proves `ffmpeg` is genuinely working on the prod VPS, since the transcode ran there. HEIC/`sharp` remains untested — it needs an iPhone *camera photo*, a different input than voice |
| 2026-07-21 | §9's PWA checklist boxes were audited against the code and checked off; only `visualViewport` composer-pinning and skeleton loaders are actually unbuilt | The boxes had rotted — the work landed across Stages 3–5 and the UI revamp but nobody went back to tick them, making Stage 6 look far emptier than it is. Auditing beats re-implementing things that already exist |
| 2026-07-21 | System back gesture / browser back is bridged to the router-less view stack via a `BackStackProvider` + `useBackHandler` LIFO handler stack (`app/src/lib/backStack.tsx`), using the "single trap, always re-armed" History-API pattern | The installed PWA's history starts empty, so a back gesture from an open chat unwound out of the SPA to a blank page. Overlays (MediaViewer, focus menu) and selection mode register handlers and close first; the view then unwinds via `parentOf` (Gallery/Profile → Chats, chat-gallery → Gallery). Root back is an inert re-arm — never blank, never an exit. |
| 2026-07-21 | Back-stack uses a single re-armed trap, **not** per-layer history entries mirroring app depth (reverted the initial guard-plus-per-layer-trap design after on-device testing) | The depth-mirroring version reconciled entry counts with programmatic `history.back()`, whose bookkeeping drifted on lateral deep→deep moves (chat → that chat's gallery → gallery) and stranded the base guard, so a later root back escaped to the blank page "almost always" (found in mobile testing). Re-arming one trap on every popstate has no count to get wrong. Cost — inert forward button, back never exits the app — is irrelevant in a standalone PWA |
| 2026-07-21 | **Scope override:** message deletion + multi-select added to §2 as MVP item 11, despite §1's "explicitly NOT a goal: message editing/deletion sync semantics beyond soft-delete" | Owner's call, made with the conflict raised rather than silently absorbed. Justification: (a) the same-day iPhone pass retired Stage 0's two GO/NO-GO risks, so remaining Stage 6 work is breadth rather than architecture-invalidating risk; (b) the shipped scope is *soft-delete only*, which arguably sits inside §1's "beyond soft-delete" carve-out rather than outside it — `messages.deleted_at` already exists and is already filtered in every read path (`chat/service.ts`, `media/gallery.ts`), so it needs **no migration**. The parts that genuinely exceed the carve-out (retention timer, hard wipe, R2 cascade) stay in §13 |
| 2026-07-21 | Delete UX = ~10s undo toast + permanent tombstone, **not** a "Deleted messages" page with a 15-minute purge timer | The stated need was "in case I did it by mistake" — a misclick is caught in seconds, not minutes, and an undo snackbar solves it with one component and zero infra. The trash-page variant answers a different question ("restore something from last week") and is where all the cost sits: first background job in the codebase, plus a Postgres↔R2 cascade with no shared transaction. Tombstones persist, so the trash page and wipe can both be layered on later without redoing this work |
| 2026-07-22 | Per-chat gallery partitions into two segments, **Media** (default) and **Voice**, replacing the old All/Images/Videos/Voice tabs; the server gains a `kind=visual` filter (image OR video) alongside the existing single-kind filters, and §7's "Type filter tabs" line is amended to match | The single "All" feed mixed masonry tiles and inline-audio rows in one scroll, which never read well once voice rows got chat-bubble-sized; a Media grid (with its own All/Images/Videos sub-filter, `kind=visual`) and a separate Voice list are genuinely different item chrome and deserve separate feeds. `kind=visual` is additive — the plain `image`/`video`/`voice` filters (and their route validation) are unchanged |
| 2026-07-22 | Gallery's Voice segment renders as a chat-skinned list — the same bubble classes/alignment/sender-label convention as `ChatView`'s voice bubble (mine/theirs colors, group sender-name label), reusing `VoiceMessage` unmodified — with a caption row (time, tag count, Jump) *outside* the bubble as gallery chrome; newest-first is kept (gallery stays newest-first by convention, not a mirror of the chat's oldest-first timeline) | A native `<audio controls>` row (the original per-item markup) overflows on mobile and looks nothing like the app; `VoiceMessage` already draws in `currentColor` specifically so it can drop into either bubble colorway unmodified. `TagEditor`'s per-item panel keeps its literal-dark internal colors (built for `MediaViewer`'s always-dark backdrop) wrapped in a dark inset panel rather than restyled, since it now sits on the app surface instead of a black backdrop — a dark panel on a light page is an accepted tradeoff, in preference to a second divergent color pass on a shared component |
| 2026-07-22 | Album cover (`GET /gallery/albums`) now picks the latest **ready media with a thumbnail** (`thumb_key IS NOT NULL`), not just the latest ready item overall | Voice media never has a `thumb_key`; picking the bare-latest item left the album tile blank whenever the newest upload in a chat was a voice message (observed live in dev). Restricting the "latest" query itself to thumb-having rows is simpler than the previous kind-based fallback and gives the same result |
| 2026-07-22 | `GalleryItem` gained `senderId` (message's `senderId`, already joined in the gallery query) alongside the existing `createdAt` | The Voice segment's chat-skinned bubbles need the sender to pick mine/theirs alignment and colors client-side, the same way `ChatView` does from `Message.senderId`; `createdAt` already existed on `GalleryItem` and now also backs the caption row's timestamp (and any future date grouping) |
| 2026-07-21 | Mobile multi-select = long-press → selection mode → tap-to-toggle, **not** long-press → drag-up with edge-accelerated autoscroll | Drag-select runs along the same axis as the list's own scroll and collides with the long-press action menu on the same element, so both gestures need fiddly disambiguation — and none of it can be verified on iOS before shipping (the `MediaViewer` gesture layer is *still* unverified there). Selection mode keeps native scrolling completely untouched, costs a fraction of the gesture code, and is what every comparable client converged on. Desktop keeps shift-click ranges + ctrl/cmd-click toggles on top |
| 2026-07-21 | Backups are a `pg_dump` piped through the existing containers (dump from `postgres`, upload from `api`) rather than a new host-installed tool (rclone/awscli) or a new service | The `api` image already carries the R2 credentials and `@aws-sdk/client-s3`, so this adds zero host dependencies and creates no second copy of the keys to leak or rotate. Retention is enforced by the uploader immediately after each upload (list prefix → delete past newest N), not by a separate cleanup job — a clamp that can't drift because it runs on the same code path that creates the growth |
| 2026-07-21 | Voice-message waveforms are computed **client-side** on first play (WebAudio `OfflineAudioContext` decode → RMS downsample → module-level cache), not stored as a `peaks` column | Keeps the UI-7 pass presentation-only: no migration, no `MediaInfo` change, no backfill for existing voice messages. Decoding on first play (rather than on mount) avoids downloading every voice note in an open chat; a deterministic ghosted placeholder pattern seeded from the media id fills the gap so a bubble is never empty. ⚠️ iOS: an OfflineAudioContext is a decoder only and needs no gesture/`resume()`, and `audio.play()` is called synchronously *before* the decode is kicked off — awaiting the fetch first would break Safari's user-gesture association |
| 2026-07-22 | Gallery masonry retuned to mosaic-style presentation (2→12px gap, 2-5 columns targeting ~200-300px tiles, 600px tile height cap, rounded/bordered cards with hover+entrance motion, video duration badges) | Pure visual retune (stage 1 of the gallery visual rework) — layout algorithm (`computeMasonryLayout`'s shortest-column packing) unchanged, only the tuning constants and card presentation. Hover raise (`scale(1.02)` + shadow) is gated behind `(hover: hover) and (pointer: fine)` so it never sticks on iOS touch; entrance fade respects `prefers-reduced-motion`. Voice rows and `MediaViewer`/`TagEditor` untouched — later stage |
| 2026-07-21 | Consecutive same-sender messages group into runs (5min window) and only the run's **last** bubble gets a tail; photos/videos render with **no bubble** behind them, captions become their own bubble underneath | Direct owner feedback on the shipped UI-3 chat screen — every bubble having a tail made bursts read as disconnected, and the container around media was Instagram-unlike. Both are pure presentation; the wire format is unchanged (see `docs/UI_REVAMP.md` UI-7) |
| 2026-07-21 | Adjacent bare photos/videos draw as a fanned card stack opening a grid sheet, and the composer accepts a multi-file pick — but a stack is **never** an addressable unit | Each card is still its own message on the wire; multi-pick just uploads sequentially, one message per file. Stacking is disabled entirely while multi-select is active, and long-pressing a stack selects all its messages individually instead of opening the single-message action sheet — so §2 item 11's per-message delete/copy semantics have no path to being applied to "a stack" |
| 2026-07-21 | Tagging stays a viewing-time action (no tag entry in the composer/upload path); the existing `TagEditor` is instead mounted in the chat-side viewer, backed by a new `GET /media/:id/tags` | Owner's call over adding tags at upload — keeps sending one tap and the send path untouched, while removing the detour through the gallery screen to tag something just received. The new route is the stage's only non-presentation change: same `assertMember` gate and the same data the gallery already returns batched, so it widens nothing |
| 2026-07-21 | Static assets get explicit `Cache-Control` in `deploy/Caddyfile` (`/assets/*` immutable for a year, everything else `no-cache`), the SW registration calls `registration.update()` on every foreground, and a `controllerchange` after the first load triggers one auto-reload | Fixes the reported "deploys are invisible on installed PWAs until you wipe all website data". Root cause was **not** the service worker: bare `file_server` sends no `Cache-Control`, so browsers applied heuristic freshness (~10% of age since `Last-Modified`, which is the image build date) and served a stale `index.html` — still pointing at the previous hashed bundle — with no revalidation. The two SW changes close the remaining gaps: an installed PWA (iOS especially, since it resumes rather than cold-launches) can go days without the navigation that would otherwise trigger an update check, and `skipWaiting()`+`claim()` were swapping the worker under a page still running the old bundle with nothing telling it to reload. Auto-reload chosen over an "update available" prompt — closed friend circle, not worth the UI |
| 2026-07-21 | UI-8 (`docs/UI8_CHAT_INSTAGRAM.md`) ships an Instagram-flavored interaction pass on the chat screen — send-animation, run-corner refinement + date/time dividers, a desktop hover action bar, an iMessage-style focus menu replacing the bottom sheet, and hold-to-record/slide-to-lock/slide-to-cancel voice recording — all hand-rolled (no animation library); reply/react are visual-only inert placeholders | Direct user feedback after living with the UI-7 chat screen. The focus menu's shared-element lift (the one piece pre-approved to fall back to `motion`/framer-motion if it proved intractable by hand) shipped hand-rolled via a `cloneNode` shared-element trick + two-phase-mount CSS transitions — the fallback was never needed. See `docs/UI_REVAMP.md` §5's UI-8 entry for the full implementation-notes list of judgment calls (divider spacing/format, panel placement simplification, the persistent-gesture-button structure in `Composer.tsx`) |
| 2026-07-22 | `ChatGallery` gets always-on day-level date sections in both segments — Media groups `gridItems` into per-day masonry restarts with a small-caps day header, Voice inserts a chat-style centered divider between day groups — no toggle, no settings; day labels share one `formatDayLabel` helper (`lib/datetime.ts`) with the chat's UI-8b `TimelineDivider` labels so the two surfaces can't drift | Stage 3 of the agreed gallery rework (Stage 1 masonry/card retune, Stage 2 Media/Voice partition). `formatDayLabel` factors the existing weekday/"MMM D"/"MMM D, YYYY" vocabulary out of `formatDateLabel` into a shared `pastDayLabel`; it differs only by printing "Today" instead of falling back to a bare time, since a gallery section header (unlike a chat divider) has no per-item time fallback. The Voice segment's per-item caption dropped from `formatSendTime` to plain `formatTime` once the new divider carries the date, avoiding a redundant date on every bubble |
| 2026-07-22 | Gallery search bar gets tag autocomplete (`TagSearchInput`) completing the query's *last* token against `GET /chats/:id/tags?prefix=`, usage counts shown, `-` negation preserved when a suggestion is applied | Stage 4 of the gallery rework. Same endpoint/debounce as the TagEditor's existing add-tag autocomplete — no server change. Last-token-only completion is deliberate: the caret sits at the end while composing a booru query in practice, and mid-string token editing isn't worth caret-tracking complexity. Dropdown uses app surface tokens (light+dark), unlike TagEditor's fixed-dark dropdown built for the viewer backdrop |
| 2026-07-22 | Gallery Media segment gains a multi-select mode (stage 5, final stage, of the gallery rework) for batch tagging — mobile: long-press a tile (identical 500ms/10px timing to `ChatView`'s existing message multi-select); desktop: a "Select" toggle button in the sub-filter row or ctrl/cmd-click a tile, plain click toggling thereafter. A tag panel appears whenever the selection is non-empty — desktop a ~320px right-side panel, mobile a bottom sheet with an expand affordance — editing the *intersection* of the selected items' tags: adding/removing a tag there fans out to every selected item. Batch ops are a client-side `Promise.allSettled` loop over the existing per-media `addTag`/`removeTag` endpoints followed by the standard `['gallery']` invalidation — **no new API surface**. Exits via an X, device/browser back (`useBackHandler`, same LIFO convention as every other overlay), or deselecting the last item; selection mode and the full-screen `MediaViewer` are mutually exclusive. Scoped to Media only — Voice keeps its existing per-item inline `TagEditor` unchanged (extending selection there, and any bulk action beyond tagging, is now Icebox §13) | Completes the agreed 5-stage gallery rework. Follows the 2026-07-21 mobile-multi-select convention (long-press → selection mode → tap-to-toggle, not drag-select) so the gesture feels identical everywhere it appears in the app, and reuses `TagEditor` unmodified for the batch editor (rather than forking a third copy of the chip/autocomplete logic already shared by the viewer's per-item editor and the voice rows' inline editor) since its `tags`/`onAddTag`/`onRemoveTag` props already fit a batch editor exactly — only *what* set of tags and *what* the callbacks do underneath differs, which is the caller's concern, not the component's. The mobile sheet's compact state is deliberately left un-height-capped rather than clipped to a fixed row count, since `TagEditor`'s autocomplete dropdown is an absolutely-positioned sibling popping up from the input and a hard clip would cut it off; "expand" instead exists for when the intersection itself is large. ⚠️ Unverified on real touch hardware, same standing device gate as the rest of Stage 5 — see that stage's entry above |
| 2026-07-22 | Fixed three UI-8d layout bugs found in real (Android PWA + desktop) testing right after the replies/reactions ship: reaction pills no longer pull up onto the bubble/media's bottom edge (`-mt-1.5` → `mt-0.5`, a clean gap below instead of an overlap that covered real image pixels on bare media); the swipe-to-reply reveal icon now centers via `inset-y-0 my-auto` instead of `top-1/2 -translate-y-1/2` (the latter doesn't reliably resolve a percentage `top` inside an auto-height flex wrapper, so the icon centered on its own bottom edge instead of the bubble and could poke into the message above on tightly-packed runs); and `MessageFocusMenu`'s backdrop dropped `backdrop-filter: blur()` entirely (flat dim only), portals to `document.body`, and force-promotes its layers via `translateZ(0)` | The focus-menu fix took two rounds. Headless Playwright testing reproduced *a* stacking bug (other message content painting over the panel) that survived a document-body portal and layer promotion, with no CSS mechanism found to explain it — logged as unresolved and shipped anyway pending real-device confirmation. Real Android PWA testing showed a *positional* pattern the headless run didn't: content above the focused bubble dimmed correctly, content below (still updating/repainting) rendered through the blur layer at full opacity on top of the panel — a known class of Android Chrome/WebView bug where `backdrop-filter` doesn't recomposite reliably against scrolling/animating content underneath. Headless Chromium's software rendering doesn't reproduce that specific compositing failure, which is why disabling blur live in the headless run appeared to change nothing at the time. Dropping blur entirely (keeping the portal + layer-promotion as defensive insurance) is the fix now pending re-verification on the reporter's device |
| 2026-07-22 | **Scope override:** MVP declared complete (owner verified the remaining breadth items on real iOS); **message replies + reactions pulled forward** out of §12's roadmap order (they were §12.4 / iceboxed in §13, nominally after passkeys/OAuth/read-receipts) | Owner's call, made explicitly with the conflict surfaced rather than silently absorbed (prime directive). MVP being done frees post-MVP work; replies/reactions were the most-requested next step and the UI-8 seams for them already existed. §12.4 marked shipped-out-of-order, §13 entry retired, this feature built across a data/server backbone + client UI pass |
| 2026-07-22 | Focus-menu compositing bug (previous entry) root-caused for real: not `backdrop-filter` — dropping the blur didn't fix it on a second real-device round. The actual cause was `MessageBlockRow`'s swipe-to-reply style setting `transition: 'transform 150ms ease-out'` **unconditionally on every message block** (true whenever `swipeDx` is 0, i.e. every bubble at rest, all the time) so it could animate the one bubble snapping back after a released swipe. Real Android testing showed *every* bubble — not just ones below the focal point — rendering above the focus menu's fixed overlay; an always-on `transition: transform` declaration is a known trigger for eager GPU layer promotion on some Android Chrome/WebView versions, and a layer promoted that way ignored the overlay's z-index entirely. Fixed by tracking which single block (if any) is actively snapping back (`ChatView`'s `snappingBackId`, armed in `onBubblePointerUp`/`onBubblePointerCancel`, cleared ~200ms later) and only that one block gets the `transition` style — every other bubble now has no `transition` in its inline style at all | The backdrop-filter theory wasn't unreasonable (it's also a real, separately-documented mobile compositing risk) but wasn't *this* bug — keeping blur off is still worth keeping since it's one fewer variable, but the swipe-transition fix is the one that actually matters. Lesson for next time: an "always-on but visually a no-op" style property is exactly the kind of thing that only misbehaves on specific real GPU compositors, which is why headless/software-rendered testing couldn't reproduce or falsify either hypothesis on its own — real-device testing was load-bearing here, not optional |
| 2026-07-22 | Replies store `messages.reply_to_message_id` (nullable self-FK, migration 005) and the API attaches a **denormalized `ReplyPreview` snapshot** (`{id, senderId, kind, preview, deleted}`) to each `Message`, resolved+batched server-side per page | The client renders the quoted block without a second fetch, and a reply survives its target being soft-deleted (`deleted:true` → "Original deleted") rather than dangling. `preview` is a ≤120-char body snippet or a media label (📷/🎥/🎤). Reply target validated same-chat + non-deleted at send time; the media path sets it during `completeUpload` |
| 2026-07-22 | Reactions store one row per `(message_id, user_id, emoji)` in a new `message_reactions` table (migration 005); the API returns **aggregated `ReactionSummary[]`** (`{emoji, count, mine}`) per message | Aggregation (`count(*)`, `bool_or(user_id=viewer)`) keeps the DTO tiny and the "mine" state correct per-viewer. Arbitrary emoji strings are stored (≤32 chars, validated) so the eventual full-picker needs no schema change; a fixed set of 6 quick emojis (`ReactionLimits.quickEmojis`) is the first-pass palette. Toggle routes are chat-scoped + `assertMember`-gated; new WS types `reaction.added`/`reaction.removed` (no reserved-prefix collision) broadcast to the chat room |
| 2026-07-22 | **Double-tap-to-react applies to every bubble including photos/videos**, accepting a ~250ms delay before a single tap opens the media viewer | Owner's explicit choice over the lower-latency "text bubbles only" alternative. A single tap is deferred by `DOUBLE_TAP_MS` to see whether a second tap (→ toggle ❤️) follows; the media-open latency is the accepted cost of "double-tap works anywhere". Disabled in selection mode; guarded so a bare-media inner `onClick` + wrapper bubbling isn't miscounted as two taps |
| 2026-07-22 | **Swipe-to-reply** is a horizontal drag *toward screen center* (theirs→right, mine→left), integrated into the existing long-press pointer handlers rather than a second pointer system | One gesture pipeline avoids the disambiguation bugs two competing `setPointerCapture` systems would create. It engages only once `\|dx\|>\|dy\|` past a 12px threshold in the toward-center direction (cancelling the long-press timer); a vertical-first move hands the gesture back to native scroll. Fires reply past a 56px threshold (72px rubber-banded cap). ⚠️ A rightward swipe near the left edge collides with iOS standalone back-edge-swipe — flagged for the device gate |
| 2026-07-22 | Reaction realtime uses **optimistic apply + pending-key dedup of the server's own echo** (mirrors the `message.send` reqId pattern), with pure reducers shared between the WS handler and the optimistic path | The reactor is in their own chat room, so the server's `reaction.*` broadcast echoes back the change they already applied locally — a `messageId:emoji:action` pending key set before the optimistic write is consumed by the matching echo instead of double-counting; other users' frames always apply. Sharing `applyReactionAdded`/`applyReactionRemoved` between both paths means they can't drift. REST failure clears the key and inverse-applies the rollback |
| 2026-07-22 | iOS PWA bottom-nav padding trimmed to `max(env(safe-area-inset-bottom) - 0.5rem, 0px)` + `py-2.5` (was full inset + `py-3`); notifications for a chat are cleared when it's opened via an SW `message` listener + per-chat notification `tag` | Owner feedback that the installed-PWA bottom bar felt too tall — the full home-indicator inset stacked on top of the button padding. The clear-on-open uses `getNotifications()` filtered by `chat-${id}` tag/`data.chatId`, triggered from `ChatView` on open + `visibilitychange`. Both are feel/best-effort and ⚠️ flagged for the iPhone device gate (bottom-bar height is a judgment value; programmatic notification dismissal is historically unreliable on installed iOS PWAs) |
| | | _(append here as decisions evolve)_ |