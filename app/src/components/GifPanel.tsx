import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Search } from 'lucide-react';
import { GifLimits, type GifSearchItem, type GifSearchResponse } from '@den/shared';
import { fetchGifSearch, fetchGifTrending } from '../lib/gifs';
import { useBackHandler } from '../lib/backStack';
import { useElementWidth } from '../hooks/useElementWidth';
import { computeMasonryLayout } from '../lib/masonry';
import { suppressTouchContextMenu } from '../lib/nativeMenu';

/**
 * The GIF picker (docs/GIFS.md §8). **Replaces** the composer row rather than
 * expanding above it (D5), which is the load-bearing decision here:
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
 * touches a third party (D10), scoped to this panel being open. Sent GIFs
 * always render from R2. `referrerpolicy="no-referrer"` on every tile.
 */

const GRID_GAP = 6;

/** Column count for the picker. Narrower tiles than the gallery's: this is a
 *  short surface (~52dvh) where seeing more candidates at once beats seeing
 *  each one large, so it doesn't reuse `galleryColumnCount`. */
function pickerColumnCount(containerWidth: number): number {
  if (containerWidth < 380) return 2;
  if (containerWidth < 640) return 3;
  if (containerWidth < 900) return 4;
  return 5;
}

export function GifPanel({ onPick, onClose }: { onPick: (gif: GifSearchItem) => void; onClose: () => void }) {
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();

  // PROJECT.md §11 requires every overlay to register. Back/Escape closes the
  // picker and restores the composer with its draft untouched.
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

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery<
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
  });

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const itemsBySlug = useMemo(() => new Map(items.map((i) => [i.slug, i])), [items]);
  const layout = useMemo(
    () => computeMasonryLayout(items.map((i) => ({ id: i.slug, width: i.width, height: i.height })), gridWidth, pickerColumnCount(gridWidth), GRID_GAP),
    [items, gridWidth],
  );

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
            onChange={(e) => setRawQuery(e.target.value)}
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

      {/* Results. `gridRef` sits on this always-rendered wrapper, not on the
          masonry container itself: the container only exists once items have
          landed, so measuring it would report 0 on the first frame that has
          something to lay out and flash an empty grid. */}
      <div ref={gridRef} className="flex-1 overflow-y-auto overscroll-contain p-2">
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
          <p className="py-8 text-center text-sm text-text-muted">{searching ? `No GIFs for “${query}”` : 'No GIFs to show.'}</p>
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
                    <GifTile gif={gif} onPick={onPick} />
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

      {/* Attribution (KLIPY terms — self-hosted text, no remote asset, so
          CLAUDE.md invariant 10 holds). */}
      <div className="border-t border-border px-3 py-1.5 text-right text-[10px] uppercase tracking-wide text-text-muted">Powered by KLIPY</div>
    </div>
  );
}

function GifTile({ gif, onPick }: { gif: GifSearchItem; onPick: (gif: GifSearchItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPick(gif)}
      onContextMenu={suppressTouchContextMenu}
      aria-label={gif.title}
      // No aspect box here: the masonry cell above already sized this tile from
      // the same reported dimensions, before any bytes arrived.
      style={{ touchAction: 'manipulation' }}
      className="media-preview h-full w-full overflow-hidden rounded-sm bg-surface-sunken"
    >
      <img src={gif.previewUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
    </button>
  );
}
