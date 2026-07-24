# Embeds & the Vault Portal (Den side)

**Status:** planned — not yet started. Off the §13 roadmap; pulled forward by owner decision (see §Bookkeeping). Paired with the Vault-side plan `the-vault/docs/DEN_EMBED_BRIDGE.md` — the two share the **§7 Contract**; implement both against it and they converge.
**Executor note:** this doc is the brief. Read CLAUDE.md and PROJECT.md §5/§6/§7/§11/§13/§15 before starting. Work phase-by-phase, top to bottom; each phase leaves the app shippable. `npm run typecheck && npm run lint && npm run test` green before any commit.

---

## 1. What we're building

A generalized **embed framework** — a message can carry a rich provider-rendered card instead of (or beside) text/media — plus its two first providers:

- **`instagram`** — paste/share a reel link; it renders as a native Den card (thumbnail + author + caption), tap opens the reel. Fully self-contained; no Vault. This is the framework's proving ground.
- **`vault`** — reference a Vault document (owner's own sibling app, `vault.ems-place.com`). Two faces:
  - **Transient embed (Mode A):** a Vault doc dropped into a chat, rendered as a card; tap → full rendered view.
  - **Chat-owned Stage (Mode B):** a per-chat persistent surface holding Vault docs the chat collectively keeps, **editable live from inside Den via a Vault-served editor iframe (the "portal")** — full Vault markdown fidelity (callouts, `![[asset]]`, math, wiki links, Live-mode) with zero renderer duplication in Den.

The provider seam is the whole point: adding a source = one server-side **resolver** + (usually) zero new client code, because all providers collapse into **one shared card renderer** with per-provider badge + tap-action.

### Core principle (locked)
> **Den is a thin host. Vault owns editing and rendering forever.** Den handles identity linking, decides *which* doc and *when* to open the portal, and owns the chat/Stage chrome around it. Nothing Den-specific is added to Vault except an allowed frame origin.

### The read/edit split (locked)
> **Read = a static snapshot** (server-rendered HTML from Vault, cached in Den). **Edit = the live portal iframe**, instantiated only on open — never one iframe per chat message.

---

## 2. Non-negotiables that apply here

- **Invariant 1 (auth = chat membership):** `assertMember(userId, chatId)` on every embed/stage route. An embed never widens visibility across chats. For Vault docs, Den membership is the gate; **Vault group membership is the mirror Den maintains** (§6.3), never the primary check on Den routes.
- **Invariant 2 (media bytes never transit the API):** embed *snapshots* follow the media pattern — client never uploads them, but the **server may fetch a remote snapshot and put it to R2** (a server-origin fetch, distinct from the client-upload path; documented exception, see §4.3). Presigned GETs ≤1h, bucket stays private.
- **Invariant 3 (server is truth):** the embed row, the snapshot, and the stage's doc list live in Den's DB/R2. The client cold-starts from the API after iOS eviction. Live Vault content is fetched server-side and relayed; the client never holds Vault tokens.
- **Invariant 4 (one WS envelope):** add `embed.ready` to the `WsType` registry (mirrors `media.ready`). No side-channel.
- **Invariant 8 (soft deletes):** `deleted_at` on `chat_vault_docs`; read paths filter it.
- **Invariant 10 (no third-party JS):** the Instagram path stays clean (server unfurl, native card — **never the IG iframe**). The **Vault portal iframe is a deliberate, logged exception** (§Bookkeeping): first-party software owned by the same owner, origin-sandboxed, no tracking, and the only sane path to full editor fidelity. It is allow-listed to exactly one origin (`vault.ems-place.com`). No other cross-origin frame is permitted.
- **Reserved paths:** do **not** touch `/auth/oauth/*` (reserved for Den's *own* login OAuth, roadmap #2) or `auth_identities` (Den login providers). Vault linking is a separate outbound-client concept: routes under `/integrations/vault/*`, a new `vault_links` table.
- **Call-readiness (§15):** never special-case DMs; a DM is the 2-member group. The Stage is a chat surface, member-count-agnostic.
- DTOs live in `/shared`, imported by both sides.

---

## 3. Phasing (each phase ships independently)

| Phase | Delivers | Vault dependency |
|---|---|---|
| **1 — Framework + Instagram** | `embeds` model, provider seam, shared card renderer, IG resolver, Web Share Target + paste-detect | none |
| **2 — Vault account linking** | OAuth client flow, `vault_links`, "Link Vault" in Profile | Vault §A (OAuth client + userinfo) |
| **3 — Vault embeds (read)** | `vault` resolver → card + rendered-HTML snapshot; tap → read view | Vault §B (render + metadata API) |
| **4 — Stage + portal editing** | per-chat Stage surface, `chat_vault_docs`, **group ownership + membership mirror**, live portal iframe | Vault §C (embed editor route, boot-session, service principal, **group + membership API**) |

Phase 1 is worth doing first even though the excitement is Vault: it exercises and de-risks the whole framework with zero cross-product coupling.

---

## 4. Phase 1 — Framework + Instagram

### 4.1 Data model (migration 010)

`messages.kind` gains `'embed'` (extend the `messages_kind_check`). An embed belongs to a message exactly as `media` does:

```ts
export const embeds = pgTable('embeds', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  messageId: bigint('message_id', { mode: 'bigint' }).notNull().references(() => messages.id),
  provider: text('provider').notNull(),          // 'instagram' | 'vault'
  status: text('status').notNull().default('processing'), // 'processing'|'ready'|'failed'
  // normalized card snapshot (provider-agnostic — the shared renderer reads these)
  title: text('title'),
  subtitle: text('subtitle'),                    // author handle / doc owner
  description: text('description'),              // caption / summary
  thumbKey: text('thumb_key'),                   // R2 key of snapshot image (nullable)
  canonicalUrl: text('canonical_url'),           // external URL (deep-link target)
  providerRef: text('provider_ref'),             // IG shortcode | vault documentId
  contentKind: text('content_kind'),             // 'video'|'image'|'document'
  actionType: text('action_type').notNull().default('external'), // 'external'|'read'|'portal'
  data: jsonb('data').$type<Record<string, unknown>>(), // provider extras (og:video url, etc.)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('embeds_provider_check', sql`${t.provider} IN ('instagram','vault')`),
  check('embeds_status_check', sql`${t.status} IN ('processing','ready','failed')`),
  index('idx_embeds_message').on(t.messageId),
]);
```

Update PROJECT.md §5 with the table + the new message kind.

### 4.2 Shared DTOs (`shared/src/api.ts` + `shared/src/ws.ts`)

```ts
// api.ts — carried inside Message when kind === 'embed' (mirror MediaInfo)
export interface EmbedInfo {
  id: string;
  provider: 'instagram' | 'vault';
  status: 'processing' | 'ready' | 'failed';
  title: string | null;
  subtitle: string | null;
  description: string | null;
  thumbUrl: string | null;        // presigned R2 GET, minted at read time (like media)
  canonicalUrl: string | null;
  contentKind: string | null;
  actionType: 'external' | 'read' | 'portal';
}
```

`ws.ts`: add `EmbedReady: 'embed.ready'` to `WsType`, payload `{ message: Message }` (identical pattern + reasoning to `MediaReadyPayload` — the resolved card replaces the processing placeholder in place).

### 4.3 Server: provider seam + IG resolver

- **Message-mint path:** when a send contains a recognized embeddable URL (client sets an intent, or server sniffs `body`), create the message `kind='embed'` + an `embeds` row `status='processing'`, broadcast `message.new` immediately (placeholder card), then resolve async → `embed.ready` on success/failure. This is the exact lifecycle `media` uses (`server/src/media/service.ts` → `process.ts`); copy its shape.
- **Resolver registry** (`server/src/embeds/registry.ts`): `provider → resolve(ctx): Promise<ResolvedEmbed>`. Keep it a plain map, like the media kind switch.
- **IG resolver** (`server/src/embeds/instagram.ts`):
  - Accept only canonical `instagram.com/reel/{shortcode}` (and `/p/`) URLs — strict regex, extract shortcode. **SSRF containment:** fetch only fixed Instagram hosts, hard timeout, response size cap, no redirects to non-IG hosts. This is Den's first server-side fetch of a user URL — treat it as hostile input.
  - Pull OpenGraph (`og:image`, `og:title`, author) — note IG's official oEmbed now needs a FB app token; unauthenticated OG scrape of the embed page is the pragmatic default. If `og:video` is present, store it in `data` (best-effort inline play later).
  - **Snapshot the `og:image` to R2** (fetch bytes server-side, re-encode WebP via sharp exactly like image processing — strips metadata too, and IG CDN URLs are short-lived so we must own the bytes). Key scheme: `embeds/{chatId}/{embedId}/thumb.webp`. Set `thumbKey`, `title`, `subtitle`, `description`, `contentKind='video'`, `actionType='external'`, `canonicalUrl`, `status='ready'`.
  - Failure → `status='failed'`; the client renders a plain clickable link fallback.

### 4.4 Client: shared card + IG send flow

- **`app/src/components/EmbedCard.tsx`** — the one renderer for all providers. Reads `EmbedInfo`: thumbnail (reserve box from a fixed aspect to avoid the scroll-jump PreviewImage fixed, see §14 2026-07-22), title, subtitle, description (clamped), provider badge, tap-action. Bare embed renders bubble-less like media; a caption (`body`) gets its own bubble (reuse `messageGroups` media-stack logic). `status==='processing'` → skeleton; `'failed'` → link fallback. Register in the message renderer alongside `MediaBubble`.
- **Send-in — Android Web Share Target:** add `share_target` to the PWA manifest (`app/` manifest / `sw.ts`). IG share sheet → Den → opens with the reel URL in the composer (or a chat-picker). ⚠️ **iOS PWAs cannot be share targets** (Apple limitation) — iPhone users copy-link → paste. Flag for the checklist.
- **Send-in — paste/detect (all platforms):** extend the composer's existing `onPaste` (docs/IMAGE_PASTE.md path) and text handling to recognize an embeddable URL and show a chip (`🎬 Instagram reel — sends as a card`). Reuse the "picking is sending" precedent — no pre-send preview step.

### 4.5 iOS flags (Phase 1)
- Web Share Target absent on iOS — copy-paste fallback is the load-bearing path for most users. ⚠️
- Card thumbnail box must reserve layout from a known aspect ratio (portrait 9:16 for reels) or the chat scroll-to-bottom regresses (same class of bug as PreviewImage).
- `instagram://` deep-link vs. browser tab from an installed PWA — verify on a real iPhone with and without the IG app installed.

---

## 5. Phase 2 — Vault account linking

Den becomes an **OAuth 2.0 client of Vault** (Vault is a spec-compliant AS: `/oauth/authorize`, `/oauth/token`, PKCE-S256, scope `vault.documents`, dynamic registration at `/oauth/register`). This is *outbound* linking — unrelated to Den's own login-OAuth roadmap item, and must not touch `/auth/oauth/*` or `auth_identities`.

### 5.1 Data model (migration 011)
```ts
export const vaultLinks = pgTable('vault_links', {
  userId: bigint('user_id', { mode: 'bigint' }).primaryKey().references(() => users.id),
  vaultUserId: text('vault_user_id').notNull(),      // Vault's user UUID (from userinfo)
  accessTokenEnc: text('access_token_enc').notNull(),  // encrypted at rest (server-only)
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scope: text('scope'),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
});
```
Tokens are **server-only, encrypted** (app-level key from env; never sent to the client). Refresh on expiry via Vault's `/oauth/token` (rotating refresh, 30-day). On refresh failure/revocation → mark link broken, prompt re-link.

### 5.2 Routes (`server/src/routes/integrations-vault.ts`, mounted `/integrations/vault/*`)
- `GET /integrations/vault/connect` → build the Vault authorize URL (PKCE: generate + store `code_verifier` in the session/one-time row), redirect the user.
- `GET /integrations/vault/callback` → exchange `code` at Vault's token endpoint, call Vault userinfo (§7 Contract A) for `vaultUserId` + display name, upsert `vault_links`. Redirect back into the PWA.
- `POST /integrations/vault/unlink` → revoke Den's copy, delete the row, and (Phase 4) revoke mirrored Vault permissions.
- `GET /integrations/vault/status` → `{ linked, vaultDisplayName }` for the UI.

### 5.3 Client
- Profile gains a "Connect Vault" section (`Profile.tsx`) → hits `/connect`, shows linked state. Plainly styled (UI polish deferred).

---

## 6. Phase 3–4 — Vault embeds, the Stage, and the portal

### 6.1 Phase 3: read (transient embeds)
- **`vault` resolver** (`server/src/embeds/vault.ts`): input is a Vault doc URL/id that the **sharer** can access (checked via the sharer's linked token against Vault). Produces the card (title/owner/snippet from Vault metadata API, §7 Contract B) and snapshots a **rendered-HTML** view (Vault render API) — cached server-side. `actionType='read'`.
- **Read view:** tapping the card opens a Den overlay that displays the **sanitized rendered HTML** in Den's own chrome (its design tokens). Assets inside resolve through Vault's permission-checked asset routes (the HTML carries resolved URLs from the render API). Snapshot is refetched lazily; server relays, client never calls Vault directly.
- **Do not** re-implement Vault's markdown dialect in Den. If the render API is unavailable, degrade to title-only card + "Open in Vault" — never a broken half-render.

### 6.2 Phase 4: the Stage
- **Surface:** a per-chat **Stage** opened from the `ChatView` header. Reuse the established search split (§14 2026-07-22): **mobile = full-screen overlay** (register on `backStack`), **desktop = right-side panel** that pushes the message column. Contents v1: the chat's Vault docs (list). *(Pinned messages/notes are a natural sibling for this surface but are out of scope here — see §Bookkeeping icebox.)*
- **Data model (migration 012):**
```ts
export const chatVaultDocs = pgTable('chat_vault_docs', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  chatId: bigint('chat_id', { mode: 'bigint' }).notNull().references(() => chats.id),
  vaultDocumentId: text('vault_document_id').notNull(),
  title: text('title'),                        // cached for the list
  addedBy: bigint('added_by', { mode: 'bigint' }).references(() => users.id), // attribution only
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [uniqueIndex('chat_vault_docs_unique').on(t.chatId, t.vaultDocumentId)]);

// chat ↔ Vault group mapping — one group per chat, created lazily on first Stage use (§6.3)
export const chatVaultGroups = pgTable('chat_vault_groups', {
  chatId: bigint('chat_id', { mode: 'bigint' }).primaryKey().references(() => chats.id),
  vaultGroupId: text('vault_group_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```
- **Shared-wiki semantics (matches Den's tag model, §10):** any member adds/removes docs from the Stage; `addedBy` is attribution only. Creating a new chat doc → Den asks Vault to create it **owned by the chat's group** and reconciles group membership (§6.3).

### 6.2.1 Stage layout & the add-card (owner design + notes)
Model the Stage on the **gallery grid**: a responsive grid of large cards, each card = one shared element (v1: one Vault doc). Reuse the gallery's grid container and card chrome so the two surfaces read as siblings.

- **The add-card is the grid's first tile, always.** A dashed-border tile with a centered `+`, same footprint as a doc card. Tap → an "add" menu. It's the persistent, discoverable entry point (mirrors the gallery's "shared element" mental model). When the Stage is empty the grid is *just* this tile plus a one-line hint ("Keep docs your chat shares here").
- **The add menu is a seam, not a single button.** v1 has one *category* (Vault doc) but two *actions* under it, and that split is the important part:
  - **New doc** → Den calls Vault to create a doc **owned by the chat's group** (§6.3), inserts the `chat_vault_docs` row, opens the portal on it.
  - **Add existing doc** → pick a doc the user can access in Vault (search via `GET /api/embed/documents` scoped to the linked user), then either reference it or transfer/link it to the group. Referencing someone's personal doc vs. group-owning it is a real ownership question — default to **"add a copy owned by the group"** so the Stage never depends on one member's private doc that can vanish when they leave. Log this choice in §14 when built.
  Keep the menu component even though there's one category — a second category (pinned notes, other providers) then costs one entry, not a redesign. *(If you'd rather not show a 1-item menu in v1, collapse it so tapping the add-card goes straight to New/Add-existing — but keep the menu abstraction underneath.)*
- **Doc card content.** Unlike gallery tiles, docs aren't inherently visual — a grid of mostly-text cards looks sparse. Give each card: title, owner/last-editor, a short snippet (from the metadata API, §7 B), `updatedAt`, and a provider/doc glyph.
- **The "paper thumbnail" (recommended, ports from Vault's own gallery).** Vault already solved the sparse-card problem with a Google-Docs-style fake page thumbnail, and the technique is **still live** in Vault today: `components/workspace/WorkspaceDocumentPreviewCard.tsx` + the `.vault-doc-preview*` rules in `app/styles/components.css`. It is **not a rendered-to-image thumbnail** — it renders real content into a "sheet" and fakes the paper look with CSS: a `4/3` preview box, `.vault-doc-preview-content { transform: scale(0.82); transform-origin: top left; width: 122%; }` (miniature of the top of the page), a hairline top edge, and a bottom gradient fade so the clipped text trails off like a real sheet.
  - **Den port:** Den must not reimplement Vault's markdown renderer (locked principle, §1), but it doesn't need to — **reuse the Phase-3 rendered-HTML snapshot** (`/rendered`, §7 B). The thumbnail = the *top slice* of that sanitized HTML dropped into the same scaled/faded sheet container, with Vault's CSS vars swapped for Den's design tokens. No Vault renderer in Den, **no new Vault endpoint, no extra storage** — the snapshot already exists for the read view, and Phase 3's read view already styles that same HTML, so the thumbnail reuses that styling cropped + scaled. Copy the `.vault-doc-preview*` CSS as the starting point.
  - **Phase ordering consequence:** the paper thumbnail depends on the Phase-3 snapshot, so a Stage shipped before Phase 3's `/rendered` lands falls back to **plain text cards** (title/owner/snippet/glyph) and gains the thumbnail once the snapshot is available. Not a blocker — a graceful upgrade.
- **Card tap = open the right surface** by the viewer's access: linked+member → **portal** (edit); unlinked → **read view** (relayed snapshot). A tiny "view"/"edit" hint on the card sets expectations before the tap.
- **Removal is shared-wiki** (matches tags/`addedBy`): any member removes a doc from the Stage via card overflow/long-press → soft-delete the `chat_vault_docs` row. **Removing from the Stage ≠ deleting the Vault doc** — the group keeps owning it; be explicit in the UI copy so a remove doesn't read as a destroy.
- **Ordering:** most-recently-updated first (needs `updatedAt` from the metadata API, refreshed on Stage open); ties broken by add order. No manual reordering in v1.

**Design critique / open calls:** the add-card + gallery-parity is the right call — discoverable and consistent. The card sparseness is **settled**: port Vault's live paper-thumbnail (above) off the Phase-3 snapshot; plain text cards are just the pre-Phase-3 fallback. The one thing left to decide before building is **new vs. attach-existing ownership** (recommend group-owned copy, above) — raise it with the owner when Phase 4 starts. All styling stays plain until the owner's UI pass ([[feedback_ui_polish_deferred]]).

### 6.3 Ownership & membership mirror (group model — confirmed)
Vault gains **native group ownership** (Vault §C): a group is a durable principal that can own documents, and group members get edit access. A **Den service principal** (a Vault service account, e.g. `den-system`) owns/administers the groups so Den can manage membership programmatically — but **documents are owned by the group, not by a person and not by Den**, so ownership survives any member leaving.

- **One group per chat, created lazily.** The first time a chat gains a Stage doc, Den creates a Vault group (`chat_vault_groups` maps `chatId → vaultGroupId`) and seeds it with the chat's currently-linked members. Stage docs are created owned by that group (`POST /api/embed/documents { title, groupId }`).
- **Den mirrors Den-chat membership → Vault-group membership** — syncing *one membership list per chat*, not per-doc grants. Only **linked** users can be group members (membership needs a Vault identity); **unlinked** members can't edit and are added the instant they link.
- **Unlinked members still read**: Den's server relays the rendered-HTML snapshot fetched **as the service principal** (which administers the group and can therefore read its docs). Viewing needs no link; editing does — a natural incentive, and linked members then see these as a real group in their own Vault dashboard, zero Den-aware code in Vault.

**Reconciliation — the mirror fires on exactly these triggers** (`server/src/embeds/vaultGroups.ts`, an idempotent `reconcileChatGroup(chatId)` plus targeted add/remove):
1. **A user joins a Den chat** → if linked, add to the chat's group (creating the group first if this is the chat's first Stage use). If unlinked, no-op — they join on link.
2. **A chat member links their Vault account** → add them to *every* chat-group they're already a member of. *(The "already in the chat, links later" case — the link callback must walk the user's chats.)*
3. **A user leaves a Den chat** → remove them from that chat's group (drops edit access).
4. **A user unlinks Vault** → remove them from every chat-group (no Vault identity anymore).

Triggers 1 & 3 hook Den's chat-member add/remove paths; 2 & 4 hook the `/integrations/vault/*` link/unlink handlers. All four are idempotent, so the periodic `reconcileChatGroup` sweep is a safe backstop for a missed event or a failed Vault call (no shared transaction spans the two apps — treat every write as retryable). Den membership stays the authoritative gate on Den routes; the Vault group is the edit-access projection.

### 6.4 The portal (live editing)
- **Boot handshake (server-mediated, cookie-free — see §7 Contract C):** Den's server calls Vault's embed-session endpoint with the acting user's linked token → gets a short-lived, single-use `embedUrl` (`vault.ems-place.com/embed/editor/<docId>?boot=<token>`). Den returns *only* that URL to the client.
- **Client:** the Stage/read overlay mounts an `<iframe src={embedUrl}>`. The iframe runs Vault's own editor (CodeMirror + Yjs + Live mode + slim toolbar), joins the real Hocuspocus room, full fidelity, real presence. **One portal at a time, on open** — never per message.
- **Auth rides the boot token, never a cookie** — iOS Safari blocks third-party cookies; this is the thing that would silently break for most users.
- **Theme:** pass `?theme=` (or `postMessage`) so the mini-editor tracks Den's surface/accent tokens + dark mode. (Polish — later pass.)

### 6.5 iOS flags (Phase 4) — the real risk surface
- **Editable cross-origin iframe + iOS keyboard.** Den's `visualViewport` composer-pinning vs. the iOS keyboard is a known-unbuilt quirk (§12), now planned in **`docs/IOS_KEYBOARD.md`** — treat that pass as a **prerequisite** for the portal. Even once it lands, the focused input here is inside an iframe Den doesn't control, so focus, scroll-into-view, and keyboard-overlap still need their own real-device verification. ⚠️ Do not call done off the Samsung.
- Cross-origin iframe inside an installed PWA (standalone) — WebSocket from the framed origin, storage partitioning (Vault editor state is server-backed via Yjs, so should be fine). Verify collab actually syncs from inside the PWA iframe on iOS.
- Frame CSP: Den sets `frame-src https://vault.ems-place.com` (and `connect-src` for its collab WS if relevant); confirm the SW/`index.css`/headers don't strip it.

---

## 7. Contract (identical in both plan docs — the convergence surface)

All endpoints are Vault's; Den calls them server-side with the acting user's OAuth bearer (or the service-account bearer for owner ops). Origins: Den `den.ems-place.com`, Vault `vault.ems-place.com`, collab `NEXT_PUBLIC_COLLAB_URL`.

**A. Identity (Phase 2)**
- Vault exposes userinfo for a bearer token: `GET /api/me` → `{ userId, name, image }`. (Today `AuthInfo.extra.userId` exists internally; this surfaces it.)
- OAuth: standard AS at issuer `https://vault.ems-place.com`, scope `vault.documents`, PKCE-S256. Den registers via `/oauth/register` (or is pre-seeded a `client_id`).

**B. Read (Phase 3)**
- `GET /api/embed/documents/:id/metadata` (bearer) → `{ id, title, ownerName, snippet, updatedAt, canEdit }` — permission-checked; 404 (not 403) when unreadable (Vault §10 convention).
- `GET /api/embed/documents/:id/rendered` (bearer) → `{ html, assets }` — **sanitized** rendered HTML with permission-resolved asset URLs; no dashboard shell. This is Vault's `MarkdownDocument` pipeline behind an API.

**C. Edit / portal / ownership (Phase 4)**
- `POST /api/embed/editor-session` (bearer) `{ documentId }` → `{ embedUrl }` — Vault checks `canEditDocument`, mints a short-lived single-use boot token, returns the `/embed/editor/<id>?boot=…` URL. The route itself boots the collab editor by minting a `createCollabToken` room token (same infra as `withLiveDocumentText`).
- `POST /api/embed/groups` (service bearer) `{ name }` → `{ groupId }` — create a group (Den makes one per chat, lazily).
- `POST /api/embed/groups/:id/members` (service bearer) `{ vaultUserId }` → add a member (idempotent). `DELETE /api/embed/groups/:id/members/:vaultUserId` → remove (idempotent). These back the membership mirror's four triggers (§6.3).
- `POST /api/embed/documents` (service bearer) `{ title, groupId }` → `{ documentId }` — create a chat-notes doc **owned by the group**.
- **CSP:** the `/embed/editor/*` route sets `Content-Security-Policy: frame-ancestors https://den.ems-place.com` — exactly Den's origin, never `*`.
- **Boot token:** short TTL (≤60s), single-use, bound to `{ documentId, vaultUserId }`, signed off `AUTH_SECRET` (reuse the `collab-token.ts` HMAC scheme).

---

## 8. Verification (definition of done, per phase)

Scripted multi-account flows against the compose stack (pattern: existing Stage/receipts scripts), plus real-device iOS gate where flagged.

- **P1:** paste + share-target a reel → placeholder card → `embed.ready` upgrades it; snapshot lands in R2 (WebP, no EXIF); bad/private URL → link fallback; non-member never sees the embed; card box reserves layout (no scroll regression). `og:image` host allow-list holds against a crafted non-IG redirect.
- **P2:** link flow round-trips (authorize → callback → `vault_links` upsert with real `vaultUserId`); token refresh works; unlink revokes; tokens never appear in any client payload.
- **P3:** share a Vault doc you can read → card renders from metadata; tap → sanitized HTML view in Den chrome; a doc you *can't* read → 404 path, graceful card; render API down → title-only degrade, never broken HTML.
- **P4:** add a doc to a Stage → the chat's **group** owns it; a linked member is in the group and can edit, an unlinked member can view (relay) but not edit; **join a chat as a linked user → added to the group; a member who links later → added to every chat group they're in; leave/unlink → removed** (the four §6.3 triggers, each idempotent, sweep-backstopped); open portal → live Yjs edit reflects in Vault and vice-versa; concurrent edit from Den + Vault does not duplicate (CRDT delta, `withLiveDocumentText` invariant); a user removed from the group mid-session loses edit at the collab connect re-check, not just token expiry; boot token is single-use + expires; a stolen `embedUrl` from a different origin is refused (frame-ancestors). **iOS real-device:** portal keyboard/focus/scroll + collab sync inside the installed PWA.
- All phases: `npm run typecheck && npm run lint && npm run test` green.

---

## Bookkeeping (same change, not a follow-up)

- **PROJECT.md §14 decision log:** (1) embed framework + Instagram provider pulled forward; (2) **invariant-10 exception**: the Vault portal iframe is permitted as first-party, origin-sandboxed, tracking-free, allow-listed to `vault.ems-place.com` only — the only path to full editor fidelity; (3) ownership model = **native Vault group ownership**; Den provisions one group per chat and mirrors chat membership → group membership (chosen over a service-account/per-doc-permission mirror because Vault can cheaply gain groups, collapsing sync from per-doc to per-chat and making doc ownership durable); (4) Vault linking is *outbound* OAuth-client, distinct from roadmap #2 (Den's own login OAuth) and does not touch `/auth/oauth/*` or `auth_identities`.
- **PROJECT.md §5:** `embeds`, `vault_links`, `chat_vault_docs`, `chat_vault_groups` tables; `messages.kind` gains `'embed'`.
- **PROJECT.md §6:** `/integrations/vault/*` routes; note the Vault APIs consumed (§7).
- **PROJECT.md §7:** `embed.ready` WS type.
- **PROJECT.md §13:** add "Embeds & Vault portal" as an in-flight item; keep in **Icebox**: Instagram full-reel rehost (ToS/storage/orphan-sweep), Stage pinned-messages/notes, non-Vault generic link unfurl, per-viewer live (non-portal) Vault ACL reconciliation.
- **Open decision to confirm with owner before Phase 4:** the §6.3 ownership model (service account + mirror). Everything else is settled.
