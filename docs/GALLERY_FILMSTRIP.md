# Media viewer filmstrip

Owner-requested, off the §13 roadmap — deferred out of `docs/MEDIA_ATTACHMENTS.md`'s review pass (§7b) and picked up as its own change. Plan doc per PROJECT.md §16; decisions settled in the 2026-08-12 design session.

## 1. What we're building

A horizontal rail of thumbnails pinned to the bottom of `MediaViewer`, the way a phone gallery does it: every item in the current result set, the active one centred and enlarged, tap to jump.

It appears in **both** viewer surfaces:
- **Gallery viewer** — the rail spans the current *filtered* result set, and pages in more as you scroll it.
- **Chat album viewer** — the rail spans the album's `media[]`. Fully loaded, no pagination, no ghosts.

It does **not** appear when the viewer was opened on a single chat image (a one-item list has nothing to strip), and never for voice (the gallery's Voice segment doesn't open the viewer at all).

## 2. Decisions (settled — do not re-litigate)

| # | Decision | Why |
|---|---|---|
| F1 | **Scrollable rail that keeps the active item centred.** Not a fit-to-width strip. | The only thing that works for a chat with hundreds of items, and it's what the phone galleries this imitates actually do. |
| F2 | **Scrolling the rail selects the centred slot** (revised 2026-08-12 after the owner used it: tap-only "does nothing but scroll the rail"). Committed on **settle**, not live. | Phone-gallery behaviour. Settle-not-live because the main view shows full-size media: selecting on every scroll frame would fetch a full-size image per slot crossed. The rail's own highlight and dent track `centredSlot` immediately, so the gesture still feels live — only the expensive part waits. Note this is *scroll*-driven, not a pointer-drag: no custom gesture, so magnification can never displace what's under the finger (the original drag-seek hazard). Any future pointer-driven seek MUST still map finger-x to **fixed slot positions** with magnification paint-only. |
| F2a | **Half-gutters (`sidePad`) so the first and last slots can reach the centre.** | Not cosmetic — it is what makes the loop converge. With them, `centred = round(scrollLeft / PITCH)` and `scrollLeft(i) = i * PITCH` are exact inverses. Without them the rail can't scroll far enough to centre slot 0, `scrollLeft: 0` maps to some positive index, and select-on-scroll oscillates forever at the ends. |
| F2b | **Scrolls we initiate are marked** (`PROGRAMMATIC_SCROLL_MS`) and never commit a selection. | The rail mounts at `scrollLeft: 0` a frame before the centring scroll starts, so opening the viewer deep in a list would otherwise commit "slot 0 is centred" and drag the viewer back to the first item. |
| F3 | **Magnification is decorative**: active ~1.7×, neighbours ~1.25× / ~1.1×, all `transform: scale()` about the slot centre. | Transform-only means it never reflows the rail, so centring maths and hit targets stay on the fixed slot grid regardless of what the pixels do. With F2 there's no interaction for it to fight. |
| F4 | **Always visible**, ~84px tall (40px slots, 1.7× active, plus padding and safe-area inset). | Owner's call, including the cost: it's a permanent bite out of the image on a phone. |
| F5 | **Video controls sit above the strip**, i.e. the rail is in normal flow and shrinks the media stage rather than overlaying it. | Falls out nicely: the `<video>` element ends where the rail begins, so `VIDEO_CONTROLS_EXCLUSION_HEIGHT` keeps working unchanged — it's measured against the video element, not the screen. An overlaying rail would have covered the native controls. |
| F6 | **Ghost slots for the unloaded tail**, sized by a real `totalCount`. | The alternative (a bare spinner at the end) makes the rail look like it ends when it doesn't. Ghosts give the "there's more out there" affordance and honest proportions. |
| F7 | **The rail infinite-scrolls**: scrolling toward the loaded frontier fetches the next page. | This is what makes F6 safe under keyset pagination — see §3. |
| F8 | **Windowed rendering** — only slots in view (± a buffer) are in the DOM. | Fixed slot width makes the arithmetic trivial. A 2,000-item chat would otherwise mount 2,000 nodes for decoration. Hand-rolled; no dependency (CLAUDE.md). |

## 3. The keyset constraint, and why the rail pages itself

Gallery paging is keyset (`before` on media id) and **§6 forbids OFFSET in new code**. So there is no way to jump straight to ghost #400: reaching it means walking pages.

F7 resolves this without touching the invariant. Ghosts are only ever *tapped* near the loaded frontier, because getting your eyes to a distant ghost requires scrolling the rail past everything in between — which loads it on the way. The one case left is tapping a ghost one page beyond the frontier: the rail marks it active, the main view holds a spinner, and it resolves when that page lands. That's the "show the ghost and take a moment" behaviour the owner signed off on.

**No new jump-to-offset API. If a future change wants one, it needs an explicit owner decision — it would be the first OFFSET in the codebase.**

## 4. Server — `GalleryResponse.totalCount`

```ts
export interface GalleryResponse {
  items: GalleryItem[];
  nextCursor: string | null;
  /** Total matches for the CURRENT filter, first page only (null on later
   *  pages) — same shape and reasoning as SearchMessagesResponse.totalCount. */
  totalCount: number | null;
}
```

**It must be filter-aware.** The viewer's list is the current tag query's result set, so the COUNT carries the same `kind` filter and the same `EXISTS`-per-positive-tag / `NOT EXISTS`-negative-tag predicates as the page query — otherwise the rail claims 412 slots while `beach -screenshots` has 30. The only condition it drops is the `before` cursor, since the total is over the whole filtered set.

Implementation note: `getGalleryPage` builds its predicates into one `conditions` array today. Split that into the filter predicates and the cursor predicate, so the COUNT can reuse the former verbatim rather than reconstructing them (two drifting copies of the tag-matching logic is exactly the bug that would silently mis-size the rail).

Cost: one extra COUNT on first pages only. Fine at friend-circle scale, and it's the established `totalCount` pattern.

The unresolvable-positive-tag early return (`{items: [], nextCursor: null}`) returns `totalCount: 0` on a first page — honestly zero, not unknown.

## 5. Client

### 5.1 `MediaFilmstrip.tsx` (new)

```ts
{
  items: { id: string; thumbUrl: string | null; sensitivity: Sensitivity | null }[];
  index: number;
  onSelect: (index: number) => void;
  /** Gallery only. Album viewers pass none of these. */
  totalCount?: number | null;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}
```

- `SLOT_W = 40`, `GAP = 4`, strip height 84px including `env(safe-area-inset-bottom)`.
- Slot count = `max(items.length, totalCount ?? 0)`; anything past `items.length` renders as a ghost.
- Centring: on `index` change, `scrollTo({ left: index * (SLOT_W + GAP) - width / 2 + SLOT_W / 2, behavior: 'smooth' })`. Driven by index changes only, so a user's own scroll is never yanked back.
- Windowing: derive the visible range from `scrollLeft` / container width, render that ± buffer, and give the row an explicit total width so the scrollbar and ghosts stay proportional.
- Loading: when the rail **settles** (`LOAD_MORE_SETTLE_MS`) with its window past `items.length`, call `onLoadMore()` — at most once per distinct loaded length.
  - ⚠️ The naive version of this (fire as soon as the window reaches the frontier, guarded only by the caller's `loadingMore` flag) **crashed the tab on mobile** and is the one thing in this component most worth not regressing. Three causes compounded: `onLoadMore` is a fresh closure each parent render so the effect re-ran constantly; the in-flight flag doesn't flip synchronously, so a fling fired several page requests before any reported as loading; and every loaded page also lands in the gallery's **un-virtualized grid** still mounted behind the viewer. One flick walked the whole gallery into memory. The settle timer (cancelled by the effect's cleanup on every scroll-driven change) means a fling requests nothing, and the frontier ref means a repeat needs `items` to have actually grown.
- Scroll state is rAF-coalesced — scroll events outpace paint on a phone, and each one would otherwise re-render a row of blurred, transformed thumbnails.
- **Sensitive items are blurred in the rail too** — a thumbnail rail is exactly where an `nsfw` item would otherwise be shown unguarded, at the moment the viewer is blurring the same image. Reuses `SensitiveOverlay` with `compact` + `interactive={false}`: the rail's tap belongs to navigation, and revealing happens in the main view.

### 5.2 `MediaViewer` props

Additive, all optional, so the single-image chat call sites stay untouched:

```ts
items?: { id, thumbUrl, sensitivity }[];   // omit → no strip
index?: number;
onSelect?: (index: number) => void;
totalCount?: number | null;
onLoadMore?: () => void;
loadingMore?: boolean;
```

The strip renders only when `items.length > 1`. `onPrev`/`onNext` stay exactly as they are — the strip is a third way to change the index, alongside the chevrons/arrow keys and the swipe gesture, not a replacement.

### 5.3 Call sites

- `ChatGallery` — passes its loaded `items`, the viewer index, `fetchNextPage`, `isFetchingNextPage` and the response's `totalCount`.
- `ChatView` — passes `viewer.list` (already the album's `media[]`, or a legacy fan's collected items) and the index. No lazy-load props.

### 5.4 iOS flags (⚠️ device gate)

- A horizontally scrolling rail inside the fixed viewer overlay, next to the image's own pointer-driven swipe/pinch gestures — the rail needs `touch-action: pan-x` so it doesn't fight them, and that interaction is unverified on iOS.
- `scroll-behavior: smooth` / `scrollTo({behavior:'smooth'})` support and feel in an installed PWA.
- More `filter: blur()` surfaces in a scrolling container (the existing perf risk, now in a rail).
- The strip's 84px plus `env(safe-area-inset-bottom)` against the home indicator.

## 5.5 Known, not yet addressed

The gallery grid behind the viewer is **not virtualized**. The filmstrip no longer force-feeds it (§5.1), but paging far through a large chat by hand still grows the DOM without bound. Raised by the owner as a future concern; it predates this feature and is the natural next thing to do if a chat's gallery ever gets heavy.

## 6. Verification

- `npm run typecheck && npm run lint && npm run test` green.
- Server: a unit test that `totalCount` respects the tag filter (a chat where the unfiltered count and the `-tag` count differ), is null on later pages, and is 0 for an unresolvable positive tag.
- Scripted flow against the compose stack: page 1 of a >limit gallery returns a `totalCount` larger than `items.length`, and page 2 returns `null`.
- Manual: rail centres on open and on every navigation; tap jumps; ghosts render past the loaded frontier and fill in as the rail scrolls; album viewer shows a rail with no ghosts; single chat image shows no rail; video controls remain usable above the rail.
