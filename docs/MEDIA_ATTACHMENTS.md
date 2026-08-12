# Staged attachments, albums, captions & sensitive media

Owner-requested, pulled forward off the §13 roadmap (same posture as image paste, message edit, embeds). Plan doc per PROJECT.md §16; decisions below were settled in the design session of 2026-08-12 and are recorded here rather than re-derived at implementation time.

## 1. What we're building

Four things that only make sense together:

1. **Staged attachments.** Picking/pasting media no longer sends it. Files land in a tray above the composer and go out when the user hits Send — with the composer text as the caption, or with no text at all.
2. **Albums.** One send = one message carrying N media, drawn as a mosaic card. (Today: N separate messages that merely *draw* as a fanned stack.)
3. **Connected captions.** A captioned photo/album is one card — media flush to the top edge, caption strip beneath in the bubble fill — not a bare image with a second bubble hanging under it.
4. **Sensitive media.** Per-item `nsfw` / `spoiler` marks, settable before send (and after, from the existing tag editors), rendering as a blurred tile with a tap-to-reveal pill.

Plus one sibling piece that this forces and that was overdue anyway: **a Settings page** off the Profile tab, holding the first real user preference.

## 2. Non-negotiables that apply here

- **Media bytes never transit the API server** (invariant 2) — staging is client-side `File` objects; the upload path is unchanged, only its *timing* moves.
- **Authorization = chat membership** (invariant 1) — every new/changed route still calls `assertMember`.
- **Server is truth** (invariant 3) — staged attachments and reveal state are deliberately client-only and deliberately lost on reload. Nothing user-visible depends on them surviving.
- **Tag normalization is shared** (invariant 5) — the reserved names go through `normalizeTagName` like everything else.
- **One `WsEnvelope`** (invariant 4) — no new envelope and no new `WsType`; the existing `tag.added`/`tag.removed` frames carry the sensitivity changes.
- **Soft deletes only** (invariant 8).

## 3. Decisions (settled — do not re-litigate during implementation)

| # | Decision | Why |
|---|---|---|
| D1 | **Bytes upload on Send, not on attach.** | Uploading eagerly would need the message row minted at attach time, and message order is keyset on `id DESC` — a message minted before a two-minute caption-typing session sorts *above* everything that arrived meanwhile. Fixing that means breaking `media.message_id NOT NULL`. Not worth it for send latency. |
| D2 | **An album is one message with N media** (not N messages, not a `group_id` column). | Only model where the caption genuinely belongs to the album. Reply/react/delete/select on an album work for free, closing `MediaStack`'s documented "nothing can produce an action scoped to the stack" hole. One push per album instead of N. `media.message_id` has only `idx_media_message`, no unique constraint — the DB already allows it, so this costs **no migration**. |
| D3 | **Captioned media renders as one container**: media flush to the top and sides, caption strip below in the bubble fill. | The caption is already the same message (`messages.body`); the "separate message" impression was purely the `gap-[2px]` + independent `rounded-lg`. Uncaptioned media is untouched (still bare, Instagram-style). Owner accepted this as revertible if it doesn't land. |
| D4 | **Mosaic for albums, fan retained for adjacency runs.** | The fan physically can't live in a caption card (back cards translate *down* 3–5px and rotate, so they either get clipped by `overflow-hidden` or land on top of the caption strip). It also becomes a real semantic distinction: a **fan** means several separate sends grouped by proximity, a **mosaic** means one album that was composed and sent together. |
| D5 | **Sensitivity is reserved tag names, not a new column.** | Owner: "we should almost always categorize based off tags rather than introduce new schema." Gets gallery search (`nsfw` / `-nsfw`), the existing batch-tag panel, the existing viewer tag editor, and shared-wiki edit semantics for free. No migration. |
| D6 | **Both labels kept** (`nsfw` *and* `spoiler`) — identical mechanics, different word. | They carry different implications; one generic "hidden" would lose that. |
| D7 | **Tags are applied inside `complete`, before fanout.** | Tagging as N REST calls after the message went out would show every other client the unblurred image for a few hundred ms — the one thing this feature exists to prevent. |
| D8 | **Reveal lasts the app session** (in-memory set, lost on reload), shared by chat and gallery. | Per-view is hostile; persisted-per-device is unreliable on the primary platform (§12: iOS evicts PWA storage, so reveals would come back randomly re-blurred). App-lifetime is honest, predictable, needs no storage, and matches Discord. |
| D9 | **The sender sees their own sent sensitive media blurred too.** | The point is shoulder-surfing; the sender already knows what it is, so one tap costs them nothing. |
| D10 | **Blur is cosmetic, not a security control.** | The real thumbnail bytes are still delivered and can be pulled out of devtools. Making it real means a degraded thumbnail at processing time, which cannot work retroactively (you can't un-generate a thumb when someone tags a year-old photo). Documented, not accidental. |
| D11 | **User settings live in `users.settings` jsonb**, typed in `/shared`, whitelisted + merged on `PATCH /me`. | Owner intends to keep adding settings for existing features; one migration ever beats one per preference. First jsonb bag in an otherwise strict schema — the typed `UserSettings` + server-side whitelist is what keeps it honest. |
| D12 | **Album tiles are fixed squares (cover-cropped), not aspect-respecting.** | Much less code, never produces a broken row. Owner accepted revisiting if mixed portrait/landscape albums look bad in practice. |

## 4. Data model & API

### 4.1 No migration for albums or sensitivity

`media.message_id` stays `NOT NULL` with its plain index; several rows may now point at one message. `messages.kind` gains **no** new value — a multi-item message carries the **first item's kind**, and album-ness is derived everywhere from `media.length > 1`. This keeps `messages_kind_check`, reply-preview building, ChatList previews, search and edit-eligibility untouched.

### 4.2 Migration 013 — `users.settings`

```sql
ALTER TABLE "users" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
```

On disk this is `server/drizzle/0012_steep_silver_surfer.sql` — drizzle's file prefixes are 0-indexed, so PROJECT.md's "migration 013" is file `0012_`, exactly as its "migration 012" (chat_vault_groups) is file `0011_`. Generated with `drizzle-kit generate`, not hand-written.

Reads always merge over `DEFAULT_USER_SETTINGS`, so a row written before this migration (or holding a partial object) still yields a complete `UserSettings`. The column is typed `Partial<UserSettings>` in Drizzle, which is honest: `{}` is a legal stored value and the completeness guarantee lives in the merge helper, not the column.

### 4.3 Shared DTOs (`shared/src/api.ts`, `shared/src/tags.ts`)

```ts
// Message: the breaking change. Length 1 for every existing message; length 0
// only for text/embed messages.
media: MediaInfo[];            // was MediaInfo | null

// MediaInfo: derived server-side from the item's tags — a projection, not a
// second source of truth. 'nsfw' wins if both tags are present.
sensitivity: 'nsfw' | 'spoiler' | null;

// tags.ts
export const SENSITIVE_TAGS = ['nsfw', 'spoiler'] as const;
export type Sensitivity = (typeof SENSITIVE_TAGS)[number];

// MediaLimits
maxAttachments: 10,

// Settings
export interface UserSettings { galleryShowSensitive: boolean }
export const DEFAULT_USER_SETTINGS: UserSettings = { galleryShowSensitive: false };
// MeResponse gains `settings: UserSettings`; UpdateMeRequest gains
// `settings?: Partial<UserSettings>` (merged, whitelisted — never replaced).
```

`Message.media` becoming an array is a breaking DTO change for stale clients. Acceptable: the SW calls `registration.update()` on foreground and auto-reloads on `controllerchange` (§11), and this is a friend circle.

### 4.4 Routes

```
POST /media/uploads
  { chatId, items: [{kind, mime, sizeBytes}], caption?, replyToId? }
  → { messageId, items: [{mediaId, presignedPutUrl, requiredContentType}] }
```

One message row + N media rows + N presigned PUTs. **The caption and reply move to the mint call** (the message owns them; they can no longer belong to "the first item"). Per-kind ceilings are enforced per item, plus `items.length <= MediaLimits.maxAttachments`.

```
POST /media/:id/complete   { tags?: string[] }     (body/replyToId removed)
```

HEAD-verify + sniff as today, then **attach `tags` before any fanout**, then process. Fanout rule: the **first** item to complete emits `message.new` (uploads are serial, so that's item 1); every later completion rides the existing `media.ready`, whose payload already carries the whole `Message` and therefore needs no per-item patching.

The invariant that makes D7 airtight: *an item's tags are attached before that item ever appears in a `ready` state*. Per-item completion satisfies this naturally — an item still uploading is `processing` and renders a placeholder, not pixels.

`PATCH /me` accepts `settings`, merging whitelisted keys onto the stored object.

### 4.5 WS

`tag.added` / `tag.removed` are **already emitted** by the tag routes (since Stage 5 — `WsType.TagAdded`/`TagRemoved`; an early grep for the literal string `"tag.added"` missed them because only the registry spells them out, and the plan originally recorded them as dead types on that basis). The gap was on the client: the existing handler only invalidated queries. It now also patches `media[].sensitivity` on cached messages, so marking an old photo `nsfw` re-blurs it live for everyone instead of waiting for a refetch.

Note `TagRemovedPayload` carries only `mediaId`/`tagId`, not the tag *name*, so the client can't tell from the frame alone whether the removed tag was a sensitive one — it re-derives from the cached tag set or falls back to invalidation. Adding the name to the payload is the cheaper fix if this ever becomes hot.

## 5. Frontend

### 5.1 Composer tray (`Composer.tsx`, `ChatView.tsx`)

- Tray renders **inside** the composer `<form>`, above the input row, so it inherits the `--kb-inset` padding (docs/IOS_KEYBOARD.md) for free. Horizontal thumbnail strip, ✕ per item, `+` to add more.
- Send appears when `draft.trim() || attachments.length > 0` (today: draft only).
- Thumbnails from `URL.createObjectURL`, revoked on removal. Videos use `<video preload="metadata">` for a first frame. ⚠️ HEIC object URLs don't decode outside Safari — fall back to a file-type tile on `onerror`.
- **Validate at attach time**, not at send: kind + `MediaLimits.maxBytes[kind]` + `maxAttachments`, reported inline in the tray.
- Paste while attachments are staged **appends** (the "Upload in progress" error goes away as a concept).
- **A failed send keeps the tray.** Failed items stay staged with a retry; nothing is silently lost, unlike today's "2 of 3 uploads failed" banner over vanished files. Retry re-PUTs to the still-valid presigned URLs (10 min TTL); giving up offers Discard, which soft-deletes the album message via the existing route. Expired URLs → re-mint as a new album and discard the old.
- Staged attachments cache per chat in an App-level ref (`attachmentCacheRef`), copying the `draftCacheRef` pattern (§11). In-memory, lost on reload — same as the draft. One wrinkle worth knowing: `Composer` revokes every `previewUrl` on unmount (so a chat the user never revisits leaks nothing), which makes cached entries' URLs dead on the way out. The `File` references survive, so `ChatView` re-mints object URLs from them when it mounts. **Never render a cached `previewUrl` directly.**
- **Voice is unchanged**: push-to-talk still sends immediately. Staging it would defeat the gesture.
- Entering **edit mode** is blocked while attachments are staged ("Send or remove the attachment first"). A hidden-but-alive tray whose contents the Update button ignores is quietly confusing.

### 5.2 Attachment sheet

Tapping any tray thumbnail opens it. This is ~80% `ChatGallery.tsx`'s existing `MobileTagSheet` (bottom sheet shell + filmstrip of removable thumbs + `TagEditor`), with a focused preview and two toggles added.

```
┌───────────────────────────────────────────────┐
│  Attachment 2 of 3                   [ Done ] │
├───────────────────────────────────────────────┤
│              ┌─────────────────┐              │  focused preview, contain,
│              │  ▓▓ preview ▓▓  │   [👁]       │  ~30dvh. Blurred if marked;
│              └─────────────────┘              │  the eye peeks without unmarking.
├───────────────────────────────────────────────┤
│  [▣] [▣] [▣]  [+]           Select multiple   │  44px thumbs, ring = focused
├───────────────────────────────────────────────┤
│  [ ⚠ NSFW ]  [ 🚫 Spoiler ]     □ Apply to all │  independent, not exclusive
├───────────────────────────────────────────────┤
│  beach ✕   sunset ✕                           │
│  [ add a tag…                              ]  │  ← TagEditor, unchanged
└───────────────────────────────────────────────┘
```

- Toggles are **independent** (they are just tags; something can be both). Display precedence: NSFW label wins.
- **Select multiple** turns the filmstrip into checkboxes; the preview collapses to "N selected" and tag chips switch to the **intersection** — exactly what the gallery's batch panel already computes. `commonTags` moves out of `ChatGallery.tsx` into a shared module rather than being copied a second time.
- In multi-select the toggles are tri-state (on / off / mixed — tapping mixed sets all on). "Apply to all" is the single-item shortcut for the common case.
- Tray thumbs carry a small `EyeOff` badge when marked, so the state is visible without opening the sheet.
- Opening the sheet dismisses the keyboard (they otherwise fight over the same 70dvh).
- Desktop: identical content as a centered ~420px modal, portalled with an **explicit `zIndex` on the outermost wrapper** (§11's stacking-context lesson) and `useBackHandler` registered.
- `TagEditor` is currently fixed-dark (built for `MediaViewer`'s black backdrop; `MobileTagSheet` works around it with a `bg-neutral-900` wrapper). Add a `tone: 'dark' | 'surface'` prop rather than propagate that wrapper a third time.

### 5.3 Card rendering (`MessageBlockRow`, `MediaBubble`, new `AlbumCard`)

**Uncaptioned single media: unchanged.** Bare, no bubble, current radius, `max-h-72`.

**Captioned single media** — one `overflow-hidden` container:

```
┌────────────────────────────┐
│▓▓▓▓▓▓▓▓ photo ▓▓▓▓▓▓▓▓▓▓▓▓▓│  flush to top and both sides
├────────────────────────────┤
│ this cat has no thoughts   │  bubble fill, normal text padding
└────────────────────────────┘
```

- Container radius = **the radius bare media uses today** (so a captioned photo isn't suddenly rounder than an uncaptioned one), with the existing run-position corner tightening moved onto the container.
- The image loses its own radius; the container clips it. That is what makes it read as one object.
- Fill = `bg-accent` (mine) / `bg-surface-sunken` (theirs) — the caption bubble's current colors, now also the container's.
- **Card width = image display width.** No minimum, no upscaling, no gutters. A narrow portrait therefore wraps its caption into a narrow column; accepted (one rule, zero edge cases) and revisited only if it annoys in practice.
- Reaction pills, the `edited` label, seen avatars and delivery status keep their existing slots relative to the container.

**Albums** — fixed-width card, 6-unit grid, square cover-cropped tiles, 2px gutters, caption strip appended when there is a body:

| N | Layout |
|---|---|
| 2 | one row of 2 (each square) |
| 3 | big tile 2×2 left + two 1×1 stacked right |
| 4 | 2×2 |
| 5 | two 3-unit tiles on top, three 2-unit tiles below |
| 6 | 3×2 |
| 7–10 | 3×2 with `+N` on the sixth tile |

- Tap a visible tile → `MediaViewer` at that index (no grid-sheet detour: the mosaic already shows what you're picking). Tap `+N` → the existing `MediaGridSheet`.
- Multi-media messages are excluded from `isStackable`, so an album never merges into a legacy fan.
- `groupMessages`' adjacency stacking stays exactly as-is for single-media messages (legacy content and "a photo, then another 30s later").

### 5.4 Blur & reveal

- `filter: blur(24px)` + slight `scale` (kills the halo) on the thumbnail, plus a centered pill: `EyeOff` + "NSFW"/"Spoiler" + "Tap to reveal".
- **First tap reveals, second tap opens.** A blurred item never jumps straight into the viewer — everywhere, including gallery tiles.
- `MediaViewer` needs the overlay too: you can swipe from a clean item onto a blurred one inside the viewer.
- **Reveal granularity:** revealing any blurred tile of an album reveals *every* blurred tile in that album (they were composed and marked together; one-by-one is the tedium this feature exists to avoid). Legacy fans keep the grid sheet's explicit "Reveal all (N)".
- Blur is **per item** — a clean tile is never hidden because a sibling is marked.
- State: one app-lifetime `Set<mediaId>` in a small context, shared by chat, mosaic, grid sheet, viewer and gallery. A "Hide again" action in the focus menu removes from it.

### 5.5 Gallery

- Setting off (default): tiles blur, sharing the same session set as chat — reveal in chat and it's already revealed in the gallery, and vice versa.
- **"Show all"** in the gallery header (rendered only when ≥1 blurred tile is loaded) flips a session-scoped gallery override rather than bulk-adding ids, so tiles from later pagination arrive revealed too. Same app-session lifetime.
- Setting on: the gallery never blurs; chat still does. The split is deliberate — the gallery is a place you navigated to on purpose, the chat is a surface you scroll past in public.
- `-nsfw` in the gallery's existing query box remains the stronger move (removes them from the grid entirely).
- **Album covers on the Gallery tab** (found during implementation, not in the original design): the per-chat cover tile had no sensitivity data at all, so it would have shown an `nsfw` photo full-size as chat decoration — the exact thing the feature exists to prevent, on the most-visible surface. Fix: the server prefers the newest **non-sensitive** thumb-having item as the cover, and `GalleryAlbum.coverSensitivity` is non-null only when every candidate was sensitive. In that case the client blurs the cover **non-interactively** (`SensitiveOverlay interactive={false}`) — tapping the tile opens the album, because there is nothing meaningful to "reveal" on a decorative cover and the grid inside does its own per-item reveal.

### 5.6 Settings page

New `{ name: 'settings' }` in `App.tsx`'s `View` union; `parentOf` → `profile` (so back unwinds Settings → Profile → Chats). `ScreenHeader` with a back arrow, same as other pushed screens.

**Profile tab** becomes a landing: a better-styled identity card (larger avatar, display name, `@username`, inline display-name edit), a `⚙ Settings ›` row, `InstallInstructions` where applicable, and Log out.

**Settings** holds: **Media & privacy** (Always show sensitive media in Gallery), **Notifications** (the enable-push button, promoted out of `DebugTools`), **Connections** (`VaultLinkSection`, moved), **Debug tools** (moved, still collapsible). Moving the existing sections is a judgment call, cheap to reverse if the owner would rather leave them on Profile.

### 5.7 iOS flags (⚠️ for the standing real-device gate — dev device is Android)

- `filter: blur()` on several images in a scrolling list — the classic "fine on the Samsung, janky on an older iPhone".
- HEIC object-URL previews in the tray (Safari decodes, Chrome doesn't — the `onerror` fallback is the untested path *on iOS*, where it shouldn't fire).
- The tray's interaction with `--kb-inset` when the keyboard is open, and the sheet-vs-keyboard handoff.
- Multi-select behavior of the iOS photo picker through `<input multiple>`.
- Long-press on tray thumbs needs `.media-preview` + `suppressTouchContextMenu` like every other preview surface.

## 6. Edge cases (decided)

| Case | Behavior |
|---|---|
| Voice | Never staged, never blurred. Sensitivity toggles hidden for voice. |
| Reply + album | Applies to the album message — now genuinely one target, unlike today's "first item only". |
| Chat switch mid-compose | Attachments cached per chat alongside the draft. |
| Push preview | Unchanged, and now one push per album instead of N. No thumbnails in push, so nothing leaks. |
| ChatList / reply previews | Derived from `media.length` → "📷 3 photos". |
| Album mid-send failure | Retry from the tray; Discard soft-deletes the message. All items failing leaves an un-fanned-out message — the same accepted orphan case as today (PROJECT.md §5). |
| Sensitive tag removed by another member | `tag.removed` unblurs live for everyone. Shared-wiki, accepted (owner call): anyone can mark or unmark anyone's media. |

## 7. Docs & bookkeeping (same change, not a follow-up)

- PROJECT.md **§5** — `users.settings` (migration 013); the "one media per message" wording updated to "one *or more*"; a note that sensitivity is derived from reserved tags.
- PROJECT.md **§6** — new `/media/uploads` shape, `complete`'s new body, `PATCH /me` settings.
- PROJECT.md **§7** — `tag.added`/`tag.removed` are live now, not reserved.
- PROJECT.md **§10** — reserved tag names.
- PROJECT.md **§11** — album/caption card rendering; the fan-vs-mosaic distinction.
- PROJECT.md **§12** — the new iOS flags.
- PROJECT.md **§14** — decision-log entry covering D1–D12 and the off-roadmap pull-forward.

## 7b. Post-review fixes (owner testing pass, 2026-08-12)

Found by the owner driving the built feature; all fixed in the same change.

| Report | Fix |
|---|---|
| Landscape media on desktop ran under the close button, leaving no obvious way out | Desktop viewer is now a **padded, size-capped stage** (`md:px-20 md:py-16`, `md:max-h-[80vh] md:max-w-[1100px]`) instead of full-bleed, so media never reaches the chrome; the close/nav buttons also got `z-10` and an opaque fill + ring for the mobile case where overlap is unavoidable. Mobile stays edge-to-edge. |
| No keyboard escape from modal views | **Escape** added to the back stack as desktop's back gesture — opt-in per layer, topmost-only (see PROJECT.md §11). Enabled on the viewer, grid sheet, attachment sheet, focus menu, search panel, Stage overlays and both selection modes. |
| Arrow buttons exist but arrow keys don't | ←/→ drive prev/next in `MediaViewer`, ignored when a text field has focus (the gallery viewer embeds `TagEditor`). Swipe already worked and now covers albums too, since album taps open the viewer with the whole `media[]` as the list. |
| Double-tap-to-react worked on album tiles but not the `+N` tile or the caption | `+N` now routes through `handleTap` like every other media tap (it was opening the grid sheet on the *first* tap, so the second landed on a tile inside the sheet). Caption strips route clicks back through `onClickBlock` with `hasMediaTap: false`, giving them the same double-tap-to-react and selection-toggle a text bubble has — they were inert because the block wrapper skips its own tap handling whenever the block owns a media tap. |
| "Apply to all" sat inside the toggles row, reading as if it scoped only the toggles and not the tag field | Replaced the "Select multiple" button **and** the "Apply to all" checkbox with one **scope row above both**: `Apply to [This one] [All N] [Choose…]`, plus a sentence spelling out what the marks and tags below will affect. |
| Typing `nsfw`/`spoiler` into the tag field silently did nothing | It now flips the matching toggle. The toggles and the tag field are one piece of state, not two — the silent `return` was the bug. (Sensitive names still don't appear as chips; the toggle is their representation, and it visibly switching on is the feedback.) |
| On mobile the attachment sheet rendered *behind* the message list | The mobile branch returned the sheet inline instead of portalling it, so a `position: fixed` element with `z-index: auto` painted at its parent's layer and lost to message blocks carrying `relative z-10`. Now portalled to `<body>` with an explicit `zIndex` — the same fix `MessageFocusMenu` already needed, and the third time PROJECT.md §11's stacking-context lesson has bitten. **Any new fixed overlay must set an explicit `zIndex` on its outermost wrapper, portalled.** |
| Desktop album/image views feel too large | Same stage cap as above, and `MediaGridSheet` is a centered `min(90vw,880px)` / `max-h-80vh` panel on desktop instead of full-screen. |

**Deferred (owner's call, explicitly out of this pass):** the viewer filmstrip — a bottom strip of the gallery's media with the active item enlarged, drag-to-seek across it, and an explicit lazy-load affordance at the right edge for the not-yet-paginated tail.

## 8. Verification (definition of done)

- `npm run typecheck && npm run lint && npm run test` green.
- Unit tests: the `MediaInfo.sensitivity` derivation (both tags → nsfw wins), `commonTags` after its move, album mosaic layout selection by N, `UserSettings` merge/whitelist on `PATCH /me`.
- Scripted multi-account flow against the compose stack (§16 pattern): A stages 3 images, marks item 2 `nsfw` and item 3 `spoiler`, captions the album, sends. Assert — B receives **one** message with 3 media; item 2/3 carry `sensitivity` **in the same frame that first shows them ready** (never a frame earlier); B's reveal of item 2 does not reveal it for A; A's own copy renders blurred; removing the `nsfw` tag from B's viewer unblurs on A live via `tag.removed`.
- Manual: caption card at both bubble sides and every run position; a narrow portrait with a long caption; an album of 2/3/4/5/7 items; a failed mid-album send and its retry; the settings toggle round-tripping through a reload.
- ⚠️ iOS device gate: §5.7's list, added to the standing checklist. Not "done" until it passes.
