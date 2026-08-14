import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Search, Star } from 'lucide-react';
import { GifLimits, type GifSearchItem, type GifSearchResponse } from '@den/shared';
import klipyLogoBlack from '../assets/klipy/powered-by-klipy-black.svg';
import klipyLogoWhite from '../assets/klipy/powered-by-klipy-white.svg';
import { fetchGifSearch, fetchGifTrending } from '../lib/gifs';
import { useBackHandler } from '../lib/backStack';
import { useElementWidth } from '../hooks/useElementWidth';
import { computeMasonryLayout } from '../lib/masonry';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { IDLE, pressCancel, pressClick, pressDown, pressFire, pressMove, type PressState } from '../lib/pressGesture';
import { useGifFavoriteKeys, useGifFavoriteMutations, useGifFavoritesList } from '../hooks/useGifFavorites';

/**
 * The GIF picker (docs/GIFS.md §8, docs/GIF_FAVORITES.md §8.2/§8.3).
 * **Replaces** the composer row rather than expanding above it (D5), which is
 * the load-bearing decision here:
 *
 *  - the composer's textarea carries the draft (App-level `draftCacheRef`,
 *    which survives the mobile/desktop remount), paste-detect for images and
 *    embed URLs, and edit mode. Repurposing it as a search field would put a
 *    half-typed message at risk for no gain;
 *  - three rounds of keyboard work (PROJECT.md §14, 2026-08-13) hang off the
 *    composer's own bottom padding. A panel floating above a live composer
 *    would give one bottom offset two owners; replacing it leaves exactly one.
 *
 * Precedent for both halves already exists: `RecordingBar` swaps the composer
 * for a mode, and `AttachmentSheet` blurs the active element on open so a tall
 * surface and the keyboard don't fight. This does the opposite of the latter
 * on purpose — it FOCUSES its own field, so the keyboard is up and the panel
 * sits on `--kb-inset` exactly like the composer it replaced.
 *
 * ⚠️ The result thumbnails come from Klipy's CDN — the one place the client
 * touches a third party (D10, extended to the Favorites tab by
 * docs/GIF_FAVORITES.md D-F4), scoped to this panel being open. Sent GIFs
 * always render from R2. `referrerpolicy="no-referrer"` on every tile.
 */

const GRID_GAP = 6;

/** Movement that reclassifies a press-and-hold as a scroll or a drag. Same
 *  value as `ChatView.LONG_PRESS_SLOP_PX` — see `onTilePointerDown` for why
 *  these two gestures are deliberately kept identical. */
const LONG_PRESS_SLOP_PX = 10;

/** Column count for the picker. Narrower tiles than the gallery's: this is a
 *  short surface (~52dvh) where seeing more candidates at once beats seeing
 *  each one large, so it doesn't reuse `galleryColumnCount`. */
function pickerColumnCount(containerWidth: number): number {
  if (containerWidth < 380) return 2;
  if (containerWidth < 640) return 3;
  if (containerWidth < 900) return 4;
  return 5;
}

type Tab = 'browse' | 'favorites';

/** What a long-press opened, plus the tile rect the popover anchors to. A
 *  single slot rather than a map: this is one pointer's gesture, and only one
 *  popover can be open (same reasoning as `ChatView.swipeState`). */
type PopoverState = { item: GifSearchItem; rect: DOMRect } | null;

export function GifPanel({ onPick, onClose }: { onPick: (gif: GifSearchItem) => void; onClose: () => void }) {
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('browse');
  const [popover, setPopover] = useState<PopoverState>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();

  const { lookup } = useGifFavoriteKeys(true);
  const { add, remove, isBusy } = useGifFavoriteMutations();

  // PROJECT.md §11 requires every overlay to register. Back/Escape closes the
  // picker and restores the composer with its draft untouched. The popover
  // registers its own handler on top of this one, so back closes the popover
  // first (the back stack is LIFO — lib/backStack.tsx).
  useBackHandler(true, onClose, { escape: true });

  // Open with the keyboard already up: this panel owns the bottom edge now, so
  // focusing immediately means the layout settles once rather than jumping
  // when the user reaches for the field.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // docs/GIFS.md §10 — debounce before a search fires. Not cosmetic: the test
  // key allows 100 calls/hour across the whole app, and per-keystroke search
  // would exhaust it in one sitting.
  useEffect(() => {
    const trimmed = rawQuery.trim();
    const handle = window.setTimeout(() => setQuery(trimmed), GifLimits.searchDebounceMs);
    return () => window.clearTimeout(handle);
  }, [rawQuery]);

  const searching = query.length >= GifLimits.minQueryLength;

  const browse = useInfiniteQuery<
    GifSearchResponse,
    Error,
    { pages: GifSearchResponse[] },
    (string | null)[],
    number
  >({
    queryKey: ['gifs', searching ? query.toLowerCase() : null],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => (searching ? fetchGifSearch(query, pageParam) : fetchGifTrending(pageParam)),
    getNextPageParam: (last, all) => (last.hasNext ? all.length + 1 : undefined),
    // Trending and any given search are stable for minutes and the server
    // caches them anyway; refetching on focus would spend quota for nothing.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    // Only fetch for the tab that's actually showing — switching to Favorites
    // shouldn't keep paging Klipy in the background.
    enabled: tab === 'browse',
  });

  const favorites = useGifFavoritesList(tab === 'favorites');

  // `GifFavorite` is structurally identical to `GifSearchItem` (slug, itemId,
  // previewUrl, width, height, title) — deliberately so, per
  // docs/GIF_FAVORITES.md §5: both tabs render through one tile component and
  // pick through one send path, so neither needs its own renderer. The only
  // difference is that a favorite's `slug` is always canonical.
  const items: GifSearchItem[] = useMemo(() => {
    if (tab === 'favorites') return favorites.data?.pages.flatMap((p) => p.items) ?? [];
    return browse.data?.pages.flatMap((p) => p.items) ?? [];
  }, [tab, browse.data, favorites.data]);

  const itemsBySlug = useMemo(() => new Map(items.map((i) => [i.slug, i])), [items]);
  const layout = useMemo(
    () => computeMasonryLayout(items.map((i) => ({ id: i.slug, width: i.width, height: i.height })), gridWidth, pickerColumnCount(gridWidth), GRID_GAP),
    [items, gridWidth],
  );

  const isLoading = tab === 'browse' ? browse.isLoading : favorites.isLoading;
  const isError = tab === 'browse' ? browse.isError : favorites.isError;
  const hasNextPage = tab === 'browse' ? browse.hasNextPage : favorites.hasNextPage;
  const isFetchingNextPage = tab === 'browse' ? browse.isFetchingNextPage : favorites.isFetchingNextPage;
  const fetchNextPage = tab === 'browse' ? browse.fetchNextPage : favorites.fetchNextPage;
  const refetch = tab === 'browse' ? browse.refetch : favorites.refetch;

  // ─── press-and-hold (docs/GIF_FAVORITES.md §8.2) ─────────────────────────
  //
  // ⚠️ THE HAZARD: a tile's click SENDS IMMEDIATELY (docs/GIFS.md D4). If a
  // completed long-press doesn't suppress its trailing click, a user reaching
  // for "Favorite" fires the GIF into a live chat where everyone sees it. That
  // is the one failure in this feature bad enough to matter, so the gesture
  // mirrors `ChatView.onBubblePointerDown` exactly rather than inventing a
  // second dialect of the same interaction.
  // The decisions live in `lib/pressGesture.ts`, which is pure and unit-tested
  // (`pressGesture.test.ts` — "a long-press must never send"). This component
  // owns only the timer and the DOM rect.
  const pressRef = useRef<PressState>(IDLE);
  const pressTimerRef = useRef<number | null>(null);

  function clearPressTimer() {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    pressRef.current = pressCancel(pressRef.current);
  }

  function onTilePointerDown(e: React.PointerEvent, item: GifSearchItem) {
    // Captured now: reading `e.currentTarget` inside the timeout would be too
    // late, and the rect is what the popover anchors to.
    const el = e.currentTarget as HTMLElement;
    pressRef.current = pressDown(e.clientX, e.clientY);
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      const next = pressFire(pressRef.current);
      pressRef.current = next;
      if (next.fired) setPopover({ item, rect: el.getBoundingClientRect() });
    }, GifLimits.longPressMs);
  }

  function onTilePointerMove(e: React.PointerEvent) {
    const next = pressMove(pressRef.current, e.clientX, e.clientY, LONG_PRESS_SLOP_PX);
    pressRef.current = next;
    // Disarmed by the slop check — this reads as a scroll or a drag now, so
    // drop the pending timer too rather than opening a popover under a moving
    // finger.
    if (!next.armed && pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }

  function onTileClick(item: GifSearchItem) {
    const { state, send } = pressClick(pressRef.current);
    pressRef.current = state;
    if (send) onPick(item);
    // else: the long-press already owned this gesture — do NOT send.
  }

  function toggleFavorite(item: GifSearchItem) {
    const canonical = lookup.canonicalSlugFor(item.itemId) ?? (lookup.hasSlug(item.slug) ? item.slug : null);
    // `canonical` is non-null exactly when this GIF is already favorited —
    // which is exactly when there is something to remove. Adding sends the
    // slug as-is (suffixed or not); the server canonicalizes it (D-F3).
    if (canonical) remove.mutate(canonical);
    else add.mutate(item.slug);
    setPopover(null);
  }

  const emptyLabel =
    tab === 'favorites'
      ? 'No saved GIFs yet. Press and hold a GIF to save it here.'
      : searching
        ? `No GIFs for “${query}”`
        : 'No GIFs to show.';

  return (
    <div className="flex flex-col" style={{ maxHeight: '52dvh' }}>
      {/* Search row — replaces the composer's own row, same 44px control
          height so the bottom edge doesn't shift on open/close. */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close GIF picker"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-border text-text-secondary transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
          style={{ touchAction: 'manipulation' }}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            ref={inputRef}
            value={rawQuery}
            onChange={(e) => {
              setRawQuery(e.target.value);
              // Typing is unambiguously a browse intent — snap back from the
              // Favorites tab rather than debouncing a search nobody can see.
              if (e.target.value) setTab('browse');
            }}
            // This input lives inside the composer's <form> (§8 — the panel
            // replaces the row but stays in the form to inherit its keyboard
            // padding). Without this, Enter triggers implicit form submission
            // and *sends the user's draft* from behind the picker. Search is
            // debounced anyway, so Enter has nothing to do here.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault();
            }}
            maxLength={GifLimits.maxQueryLength}
            // Attribution: KLIPY's terms require this exact placeholder.
            placeholder="Search KLIPY"
            aria-label="Search KLIPY"
            className="w-full rounded-pill border border-border bg-surface-sunken py-2.5 pl-9 pr-3 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent"
            style={{ touchAction: 'manipulation' }}
          />
        </div>
      </div>

      {/* Tabs. Kept below the search row rather than replacing it: the row's
          height is what holds the panel's bottom edge steady against the
          keyboard, and swapping it per tab would reintroduce exactly the
          two-owners-for-one-offset problem D5 exists to avoid. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5" role="tablist">
        <TabButton active={tab === 'browse'} onClick={() => setTab('browse')} label={searching ? 'Results' : 'Trending'} />
        <TabButton active={tab === 'favorites'} onClick={() => setTab('favorites')} label="Favorites" icon />
      </div>

      {/* Results. `gridRef` sits on this always-rendered wrapper, not on the
          masonry container itself: the container only exists once items have
          landed, so measuring it would report 0 on the first frame that has
          something to lay out and flash an empty grid. */}
      <div
        ref={gridRef}
        // A scroll cancels any in-flight press-and-hold. The slop check above
        // catches most of it, but a momentum scroll started elsewhere can move
        // this list under a stationary finger — and a popover that opened
        // because the list moved would be baffling.
        onScroll={clearPressTimer}
        className="flex-1 overflow-y-auto overscroll-contain p-2"
      >
        {isLoading ? (
          <div className="grid place-items-center py-10 text-text-muted">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-text-muted">
            <p>Couldn&apos;t load GIFs.</p>
            <button type="button" onClick={() => void refetch()} className="rounded-pill bg-surface-sunken px-3 py-1 text-xs font-medium text-text-secondary">
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="whitespace-pre-line py-8 text-center text-sm text-text-muted">{emptyLabel}</p>
        ) : (
          <>
            {/* Shortest-column masonry, not a fixed grid: GIF aspect ratios
                vary wildly, and in a row-based grid one portrait tile sets the
                row height and every landscape tile beside it sits in a pool of
                dead space (owner report, 2026-08-14). Reuses the gallery's
                packer — which deliberately isn't CSS `column-count`, because
                that reorders items away from relevance order (lib/masonry.ts).
                Every tile's box is known before its bytes load, so nothing
                reflows as images decode. */}
            <div className="relative" style={{ height: layout.containerHeight }}>
              {layout.tiles.map((tile) => {
                const gif = itemsBySlug.get(tile.id);
                if (!gif) return null;
                return (
                  <div key={tile.id} className="absolute" style={{ left: tile.left, top: tile.top, width: tile.width, height: tile.height }}>
                    <GifTile
                      gif={gif}
                      favorited={lookup.hasItem(gif.itemId) || lookup.hasSlug(gif.slug)}
                      onClick={() => onTileClick(gif)}
                      onPointerDown={(e) => onTilePointerDown(e, gif)}
                      onPointerMove={onTilePointerMove}
                      onPointerUp={clearPressTimer}
                      onPointerCancel={clearPressTimer}
                    />
                  </div>
                );
              })}
            </div>
            {hasNextPage && (
              <button
                type="button"
                onClick={() => void fetchNextPage()}
                disabled={isFetchingNextPage}
                className="mt-2 w-full rounded-md py-2 text-xs font-medium text-text-secondary disabled:opacity-50"
                style={{ touchAction: 'manipulation' }}
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
      </div>

      {/* Attribution — "Logo in picker/selector", KLIPY's Brand Attribution
          Guideline (docs/GIFS.md §9): *display the "Powered by KLIPY" logo …
          near the search bar or preview area and keep it visible while the
          selector is open*. Optional in their terms, but free to satisfy and
          it is their own reference layout.

          Their official SVGs, self-hosted from `app/src/assets/klipy/` — so
          CLAUDE.md invariant 10 holds (no CDN, no remote asset), and the mark
          is never recolored: the black and white files are theirs, swapped by
          theme rather than filtered or tinted. Dark mode here is
          `prefers-color-scheme` (index.css), which is exactly what Tailwind's
          `dark:` variant keys off. */}
      <div className="flex shrink-0 items-center justify-end border-t border-border px-3 py-1.5">
        <img src={klipyLogoBlack} alt="Powered by KLIPY" className="h-3 w-auto opacity-70 dark:hidden" />
        <img src={klipyLogoWhite} alt="Powered by KLIPY" className="hidden h-3 w-auto opacity-70 dark:block" />
      </div>

      {popover && (
        <FavoritePopover
          rect={popover.rect}
          favorited={lookup.hasItem(popover.item.itemId) || lookup.hasSlug(popover.item.slug)}
          busy={isBusy}
          onToggle={() => toggleFavorite(popover.item)}
          onClose={() => setPopover(null)}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, label, icon }: { active: boolean; onClick: () => void; label: string; icon?: boolean }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        'flex items-center gap-1 rounded-pill px-3 py-1 text-xs font-medium transition-colors ' +
        (active ? 'bg-surface-sunken text-text-primary' : 'text-text-muted hover:text-text-secondary')
      }
      style={{ touchAction: 'manipulation' }}
    >
      {icon && <Star size={12} className={active ? 'fill-current' : undefined} />}
      {label}
    </button>
  );
}

function GifTile({
  gif,
  favorited,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  gif: GifSearchItem;
  favorited: boolean;
  onClick: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      // Stops iOS's native image callout from racing the popover on a hold.
      onContextMenu={suppressTouchContextMenu}
      aria-label={gif.title}
      // No aspect box here: the masonry cell above already sized this tile from
      // the same reported dimensions, before any bytes arrived.
      style={{ touchAction: 'manipulation' }}
      className="media-preview relative h-full w-full overflow-hidden rounded-sm bg-surface-sunken"
    >
      <img src={gif.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
      {favorited && (
        // Read-only marker, not a control: the tile is one button whose click
        // sends, so a nested button here would be both an accessibility
        // problem and a second thing to mis-tap on a small tile.
        <span className="pointer-events-none absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-pill bg-black/45 text-white" aria-hidden>
          <Star size={11} className="fill-current" />
        </span>
      )}
    </button>
  );
}

/** Anchor margins for the popover — same intent as `MessageFocusMenu`'s
 *  `VIEWPORT_MARGIN`: clean edges, never flush against the screen. */
const POPOVER_MARGIN = 8;
const POPOVER_WIDTH = 168;
const POPOVER_HEIGHT = 44;

/**
 * The one-row popover a press-and-hold opens (docs/GIF_FAVORITES.md §8.2).
 *
 * Positioning is `MessageFocusMenu`'s arithmetic, deliberately copied rather
 * than the component reused: that one carries a lifted-bubble clone, a dim
 * backdrop and a full action list, none of which belong on a picker tile.
 */
function FavoritePopover({
  rect,
  favorited,
  busy,
  onToggle,
  onClose,
}: {
  rect: DOMRect;
  favorited: boolean;
  busy: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  // Registers above the panel's own handler, so back/Escape closes this first
  // (LIFO — lib/backStack.tsx).
  useBackHandler(true, onClose, { escape: true });

  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const fitsBelow = viewportH - rect.bottom >= POPOVER_HEIGHT + POPOVER_MARGIN;
  const top = fitsBelow ? rect.bottom + POPOVER_MARGIN : rect.top - POPOVER_HEIGHT - POPOVER_MARGIN;
  const left = Math.min(
    viewportW - POPOVER_WIDTH - POPOVER_MARGIN,
    Math.max(POPOVER_MARGIN, rect.left + rect.width / 2 - POPOVER_WIDTH / 2),
  );

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 100 }}>
      <div className="fixed inset-0" onClick={onClose} onPointerDown={onClose} />
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className="flex items-center gap-2 rounded-md bg-surface-raised px-3 text-sm text-text-primary shadow-strong disabled:opacity-60"
        style={{
          position: 'fixed',
          top: Math.max(POPOVER_MARGIN, top),
          left,
          width: POPOVER_WIDTH,
          height: POPOVER_HEIGHT,
          touchAction: 'manipulation',
        }}
      >
        <Star size={15} className={favorited ? 'fill-current' : undefined} />
        {favorited ? 'Unfavorite' : 'Favorite'}
      </button>
    </div>,
    document.body,
  );
}
