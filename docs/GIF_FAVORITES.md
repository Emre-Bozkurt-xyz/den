# GIF favorites (Klipy)

**Status:** planned, not started. Owner decision 2026-08-14 pulled this out of the icebox (`docs/GIFS.md` §13 listed "GIF search history/favourites" there); log it in PROJECT.md §14 with the implementation.
**Executor note:** this doc is the brief, and it is a *sequel* — read `docs/GIFS.md` first, especially §5 (the embed row shape), §9/D10 (the one third-party touch) and §12 (Klipy's wire format, including the slug suffix that §4 below turns on). Then CLAUDE.md and PROJECT.md §5/§6/§11. `npm run typecheck && npm run lint && npm run test` green before any commit. Styling stays plain — the owner does a UI pass separately.

---

## 1. What we're building

A per-user favorites list for GIFs, reachable from the three places a GIF is ever seen:

1. **In chat** — a GIF already sent can be starred, from the focus menu (mobile long-press) or the hover action bar (desktop).
2. **In the picker** — a search result can be starred via press-and-hold, which opens a one-row popover anchored to that tile.
3. **A Favorites tab in the picker**, listing everything starred, where tapping sends exactly like any other picker tile.

Favorites are **private to each user** and are not chat-scoped: starring a GIF in one chat and sending it in another is the point.

---

## 2. The identity problem — the thing this feature is actually built on

A favorite has to be keyed on something stable, and `docs/GIFS.md` §12 established that **slugs in search results are not**: every item in one response carries the same rotating suffix (`…--kDRvizpFG`), which is an analytics token, not part of the item's identity. The canonical slug is only learned by calling `gifs/{slug}`.

That is fine for *storing* a favorite (the server canonicalizes — §6), but it breaks the picker's star state: a search result cannot be matched against a stored favorite by slug, because its slug is decorated differently every time.

**Measured 2026-08-14 — Klipy's numeric `id` is stable across canonicalization:**

```
search "cat"       item[0]   id=2484942301552561   slug=goatplaybanjo-chat-4--kDRvizpFG
gifs/{that slug}             id=2484942301552561   slug=goatplaybanjo-chat-4
```

Same id across two structurally different responses — one suffixed, one not. So the id is item identity, not response state, and the picker can match on it at zero extra API cost.

> ⚠️ **This is one probe, and the confirming leg failed to run.** A second search 70s later returned the *same* response token (`--kDRvizpFG` both times), so it was almost certainly served from Klipy's cache and proved nothing about rotation. The by-slug comparison above is the only real evidence. Treat "id is stable" as a **checked assumption with a floor**, not a certainty: if an id is ever missing or unmatched, the star renders **unfilled** rather than guessing. An unfilled star on an already-favorited GIF costs one duplicate `POST`, which the unique index absorbs as a no-op. Nothing corrupts.
>
> `docs/GIFS.md` §12 already rejected regex-stripping the suffix, and that rejection stands here: a legitimate slug may contain `--`.

---

## 3. Non-negotiables that apply here

- **Invariant 1 (auth = chat membership) does not apply, and that needs saying out loud.** Favoriting is a user-scoped action whose entire payload is a **public provider ID**. No chat, message, or embed row is referenced, so there is nothing for `assertMember` to guard and nothing that can widen visibility across chats. The routes are `requireAuth` and every query is filtered to `req.user.id`.
- **Invariant 3 (server is truth):** favorites live in Postgres, never in `localStorage`. iOS evicts PWA storage; a favorites list that vanished on eviction would be worse than not having one.
- **Invariant 7 (never trust the client):** the client sends **only a slug**, exactly as the send path does. Every stored field — canonical slug, item id, preview URL, dimensions, title — is derived server-side from Klipy's own response. A client-supplied URL is never stored, and therefore never later rendered in an `<img>`.
- **Invariant 8 (soft deletes):** **does not extend to this table** — see D-F2.
- **Invariant 10 (no third-party JS/CDN):** the Favorites tab hotlinks Klipy's CDN, which *extends* the D10 carve-out. Owner decision, 2026-08-14 — see D-F4, which is the one place this feature knowingly spends invariant budget.
- **Keyset pagination, no OFFSET** (`before` cursor on `id`) — this is our own table, so the house rule applies with no provider caveat.
- DTOs live in `/shared`.

---

## 4. Data model — migration 015

> ⚠️ **Numbering:** PROJECT.md counts migrations 1-indexed, files are 0-indexed. The head after GIFs is `server/drizzle/0013_organic_dexter_bennett.sql` = "migration 014". So this is **migration 015, file `0014_*.sql`**.

```sql
CREATE TABLE gif_favorites (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES users(id),
  provider         text   NOT NULL,
  provider_ref     text   NOT NULL,  -- CANONICAL slug (never a suffixed one)
  provider_item_id text   NOT NULL,  -- Klipy's stable numeric id, stored as text
  preview_url      text   NOT NULL,  -- Klipy CDN, server-derived (D-F4)
  width            integer NOT NULL,
  height           integer NOT NULL,
  title            text   NOT NULL,  -- alt text: an accessibility field
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gif_favorites_provider_check CHECK (provider IN ('klipy'))
);

CREATE UNIQUE INDEX gif_favorites_user_item ON gif_favorites (user_id, provider, provider_ref);
CREATE INDEX idx_gif_favorites_user ON gif_favorites (user_id, id DESC);
```

Notes on the shape:

- **`provider` + a CHECK, with one value in it.** Deliberate mirroring of `embeds_provider_check`. `docs/GIFS.md` §2 says to assume a provider swap will happen; a favorites table hardcoded to Klipy would be the thing that made that swap expensive.
- **`provider_item_id` is `text`, not `bigint`.** Klipy's ids are ~16 digits and would fit a `bigint`, but they are opaque handles, not numbers — nothing sorts, sums or ranges over them, and a future provider's id may not be numeric at all. Text also sidesteps the bigint↔JSON serialization dance for a value that is only ever compared for equality.
- **The unique index is on `provider_ref`, not `provider_item_id`.** The slug is the key the send path and the delete route both use; the item id exists purely for picker matching (§2). Uniqueness on the slug is what makes a double-`POST` a harmless no-op.
- **`preview_url` is a cache of a third-party URL and will eventually rot.** That is accepted and bounded — see D-F4 for the failure behaviour.

**Cap: 500 favorites per user.** Not for storage (the rows are tiny) but because §6's `keys` route returns the whole set unpaginated. Exceeding it returns a clear error, never a silent drop.

---

## 5. Client DTOs (`shared/src/api.ts`)

```ts
/** A stored favorite. Shares `previewUrl`/`width`/`height`/`title` with
 *  `GifSearchItem` on purpose — the Favorites tab renders through the exact
 *  same tile component as search results. */
export interface GifFavorite {
  slug: string;        // canonical
  itemId: string;      // provider's stable id (§2)
  previewUrl: string;
  width: number;
  height: number;
  title: string;
}

/** Just enough to answer "is this starred?" for every surface at once (§6). */
export interface GifFavoriteKey {
  slug: string;    // canonical — the key the DELETE route takes
  itemId: string;  // what a search result is matched on
}
```

`GifSearchItem` gains **`itemId: string`**. Its doc comment currently reads "`slug` is the ONLY field the client ever sends back" — that stays true, and should be reworded rather than deleted: `itemId` is for local matching only and is never sent to the server.

---

## 6. API surface

```
GET    /api/gifs/favorites?before=   → { items: GifFavorite[], nextCursor: string | null }
GET    /api/gifs/favorites/keys      → { keys: GifFavoriteKey[] }
POST   /api/gifs/favorites           → { slug } → GifFavorite
DELETE /api/gifs/favorites/:slug     → { ok: true }
```

All four `requireAuth`, all scoped to `req.user.id`, all 503 when `gifsEnabled` is false (mirroring `/gifs/search`, so a deployment without a Klipy key has no half-working surface).

**Why `keys` is a separate route.** All three surfaces need the same question answered — *is this GIF starred?* — but they hold different handles: the picker has an `itemId`, a chat card has a canonical slug, the Favorites tab has both. One small unpaginated list serves all three, is cached once by TanStack Query per panel open, and is what makes the star state cost zero extra Klipy calls. Bounded by the 500-favorite cap (§4).

**Why `DELETE` takes the canonical slug even though the picker doesn't have one.** It doesn't need to: you can only unfavorite something that is already in `keys`, so the client resolves `itemId → slug` from that list it already holds. This keeps one delete key across all three surfaces instead of a route that accepts two different handles.

**`POST` takes only a slug — suffixed or canonical, both resolve.** The server calls `gifBySlug`, which returns the canonical slug, the stable id, the renditions and the title, and stores what *it* read. One Klipy call per favorite-add. That is the price of not trusting a client-supplied URL, and it is worth paying: a stored client URL would later be loaded in an `<img>` in that user's own favorites tab.

> ⚠️ **Rate limit.** One Klipy call per add is nothing on the production key (unlimited) but is real on the **test key's 100/hr**, shared with search. Add a modest per-user add limit and expect to notice this during development if the production key hasn't landed yet.

---

## 7. Server implementation

**`server/src/gifs/favorites.ts`** (new) — all DB access. `listFavorites(userId, before)`, `favoriteKeys(userId)`, `addFavorite(userId, slug)`, `removeFavorite(userId, slug)`. `addFavorite` calls `gifBySlug` (already exported from `gifs/klipy.ts`, already used by the resolver) and inserts `ON CONFLICT DO NOTHING`, returning the existing row on conflict so a double-tap is idempotent rather than a 409.

**`server/src/routes/gifs.ts`** — the four routes above join the two that exist. `:slug` is validated with `isValidGifSlug` before it reaches a query; it is only a DB parameter here rather than a URL path segment, but the module's existing discipline is not worth relaxing selectively.

**Nothing else on the server changes.** Sending from the Favorites tab reuses the `message.send` `gif` intent verbatim (`docs/GIFS.md` §6) — the resolver re-fetches by slug exactly as it does for a picker send, so there is no second send path, no new WS type, and no new embed shape.

**`EmbedInfo` gains `providerRef: string | null`** (`shared/src/api.ts`, projected in `server/src/mappers.ts`). A chat GIF card currently has no handle to favorite with. This exposes nothing new — for a `klipy` row it is literally the tail of `canonicalUrl`, which the client already receives — and the alternative (parsing the slug back out of a URL) is the kind of trick that quietly breaks when a URL format changes.

---

## 8. Client

### 8.1 In chat — no new affordance

A GIF bubble on desktop **already** reveals `MessageActions` (More / Reply / React) beside it on hover, and long-press **already** opens `MessageFocusMenu`. Both get a star; neither is a new surface:

- **`MessageActions.tsx`** — a fourth `IconButton` (`Star`), rendered only when the message is an inline GIF. Owner decision 2026-08-14 (D-F5): a star overlaid on the image's top corner was considered and rejected, because it would appear at the same instant as this bar and give one bubble two competing hover affordances.
- **`MessageFocusMenu.tsx`** — a `Favorite` / `Unfavorite` row, guarded the way `Copy` and `Edit` already are (`message.embed?.contentKind === 'gif'`). ⚠️ The menu's `PANEL_ESTIMATED_HEIGHT` (300) drives its above/below placement and is already documented as a judgment call — one more row is within its slack, but it is worth a glance on a short viewport.

### 8.2 In the picker — press-and-hold

Press-and-hold on a tile opens a one-row popover (`★ Favorite` / `★ Unfavorite`) anchored to that tile, flipping above/below by available space. `MessageFocusMenu` already solves exactly this positioning problem (`panelFitsBelow` / `panelFitsAbove` / `VIEWPORT_MARGIN`); copy the arithmetic, not the component — that one carries a lifted-clone animation and a full action list this doesn't want.

> ⚠️ **This is the one genuinely dangerous part of the feature.** A picker tile's click **sends immediately** (`docs/GIFS.md` D4, "picking is sending"). If a long-press doesn't suppress its trailing click, a user who meant to favorite instead **fires a GIF into a live chat where everyone sees it**. `ChatView` has the exact pattern to follow — `LONG_PRESS_MS = 500`, `LONG_PRESS_SLOP_PX = 10`, a `suppressClickRef` cleared on the *next* pointerdown (see its comment about a long-press whose click never arrives), and cancellation once the gesture reads as a scroll. It is inline in `ChatView`, not a hook, so this is new code and **must** carry its own test rather than resting on a component reuse.

Tiles keep `suppressTouchContextMenu`, which is what stops iOS's native image callout from racing the popover.

### 8.3 The Favorites tab

`GifPanel` gains a two-tab header (`Trending`/search results ↔ `Favorites`). Same `computeMasonryLayout`, same `GifTile`, same send path — the tab swaps the data source, nothing else. Empty state names the gesture, since press-and-hold is not discoverable: *"Press and hold a GIF to save it here."*

Sending from Favorites passes the stored `width`/`height` as the aspect hint, exactly like a search-result send (`server/src/aspectHint.ts`).

---

## 9. What this deliberately does not do

- **No shared or per-chat favorites.** Per-user only. A shared collection is a different feature with a real permission model behind it; it goes to the icebox.
- **No favoriting of non-GIF embeds or media.** "Save this photo" is a gallery concept and the gallery already has tags.
- **No reordering, folders, or renaming.** Reverse-chronological, one flat list.
- **No search-history feature**, despite sharing an icebox line with this one. It has none of the same machinery.
- **No sync of favorites into the send path's dedupe.** Favoriting a GIF does not change how or where it sends.

---

## 10. Decisions (log these in PROJECT.md §14)

- **D-F1 — Favorites are keyed on the canonical slug, with the provider's stable numeric id stored alongside for matching.** The slug alone cannot answer "is this search result starred?" because search slugs carry a rotating suffix (§2). Measured, with an explicit unfilled-star floor if the assumption ever fails.
- **D-F2 — `gif_favorites` hard-deletes on unfavorite.** CLAUDE.md invariant 8 ("soft deletes only") governs *content* — messages and media, things whose disappearance is a loss. A favorite is a per-user toggle edge, and every comparable table already hard-deletes: `message_reactions` (`chat/reactions.ts`), `media_tags` (`media/tags.ts`), `friendships`, `vault_links`. A `deleted_at` here would also make re-favoriting an un-delete, which is strictly worse than an insert.
- **D-F3 — The client sends only a slug; the server derives every stored field via `gifBySlug`.** Costs one Klipy call per add. Keeps invariant 7 intact and, specifically, keeps a client-chosen URL out of a column that is later rendered in an `<img>`.
- **D-F4 — The Favorites tab hotlinks Klipy's CDN (owner decision, 2026-08-14).** This **extends** `docs/GIFS.md` D10, whose reasoning was explicitly scoped to "a transient surface" — a favorites collection is persistent, so the extension should be recorded rather than assumed to be covered. Accepted because the tab lives *inside* the picker, which already contacts Klipy whenever it is open, so it adds no new host and no new contact moment. **Sent GIFs are unaffected — always R2 (D2).** Failure mode when a URL rots: that tile shows a broken-image placeholder and can be removed; the favorite is still sendable, because sending re-resolves from the slug server-side. The documented upgrade, if this ever needs tightening, is snapshotting favorite bytes to R2 under a user-scoped key — considered and deferred here for a new R2 namespace outside the chat-scoped key model, a delete lifecycle, and a refcount question when several users favorite the same GIF.
- **D-F5 — The chat-side star reuses the existing hover bar and focus menu rather than an overlay on the image** (owner decision, 2026-08-14). One affordance per surface; a corner overlay would appear simultaneously with `MessageActions` on hover.
- **D-F6 — `EmbedInfo` gains `providerRef`** so a chat card has a handle to favorite with, rather than parsing the slug back out of `canonicalUrl`.
- **D-F7 — One `keys` route serves all three surfaces' star state**, and the picker resolves `itemId → slug` from it for unfavoriting, so `DELETE` keeps a single key.

---

## 11. Verification (definition of done)

`npm run typecheck && npm run lint && npm run test` green, plus:

- **The long-press hazard, tested explicitly:** a completed press-and-hold on a picker tile opens the popover and **sends nothing**. This is the one regression that would be bad enough to notice in a real chat, so it gets a real test, not a manual check.
- Favorite from all three surfaces; confirm one row, canonical `provider_ref` (no `--` suffix), correct `provider_item_id`.
- Double-`POST` the same slug → still one row, no error.
- The star renders filled for an already-favorited search result **in a fresh search** (i.e. across a rotated response token — this is the §2 assumption actually being exercised).
- Unfavorite from the picker (via the `itemId → slug` resolution) and from chat; row gone, star clears on all surfaces.
- Send from the Favorites tab → identical `embeds` row to a search-result send, R2-hosted, absent from the gallery.
- A second account's favorites are invisible to the first: `GET /gifs/favorites` returns only the caller's rows, and `DELETE` on another user's slug removes nothing.
- 503 on all four routes with `KLIPY_API_KEY` unset.
- The 500-favorite cap returns a clear error rather than silently dropping.
- ⚠️ **iOS device gate** (PROJECT.md §12) — joins the queue behind the existing GIF flags: press-and-hold vs. iOS's native image callout on a picker tile; the popover's placement against the keyboard, which is up while the panel is open; the two-tab header plus the masonry at 360px; the fourth icon in the hover bar is desktop-only and unaffected.

---

## Bookkeeping (same change, not a follow-up)

- **PROJECT.md §5:** migration 015 — new `gif_favorites` table; note the hard-delete carve-out (D-F2) so it doesn't read as an invariant-8 violation.
- **PROJECT.md §6:** the four `/gifs/favorites*` routes.
- **PROJECT.md §11:** `GifPanel`'s Favorites tab and the picker's long-press popover; the `MessageActions` / `MessageFocusMenu` additions.
- **PROJECT.md §12:** the new iOS flags from §11 above.
- **PROJECT.md §13:** remove "GIF favourites" from the icebox (search history stays); add as in-flight.
- **PROJECT.md §14:** one entry covering D-F1–D-F7, with **D-F4** called out as the load-bearing one — it spends invariant-10 budget beyond what `docs/GIFS.md` D10 already covered.
- **`docs/GIFS.md` §12:** add the measured `id`-stability finding, with the caveat that the rotation leg was inconclusive.
