import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Sensitivity } from '@den/shared';
import { SensitiveOverlay } from './SensitiveOverlay';

/**
 * The media viewer's bottom rail (docs/GALLERY_FILMSTRIP.md).
 *
 * A scrollable row of thumbnails that keeps the active item centred, the way
 * a phone gallery does. Tap a slot to jump. Used by both viewer surfaces: the
 * gallery viewer (whole filtered result set, pages in as you scroll) and the
 * chat album viewer (the album's own items, fully loaded).
 *
 * Two things are load-bearing and easy to break:
 *
 *  - **Slots are a fixed grid; magnification is paint-only.** Every item owns
 *    a `SLOT_W`-wide slot, and the active/neighbour enlargement is a
 *    `transform: scale()` about the slot centre, which paints outside the
 *    slot without reflowing anything. Centring maths and hit targets stay on
 *    the fixed grid no matter what the pixels do. If drag-to-seek is ever
 *    added (deliberately NOT built — F2), it must map finger-x to these fixed
 *    slots too, or magnification and seeking form a feedback loop: the item
 *    under your finger grows, displaces its neighbours, and a different item
 *    ends up under a stationary finger.
 *
 *  - **Ghost slots past `items.length`.** The gallery pages 60 at a time on a
 *    keyset cursor, so the rail can't show what a phone gallery shows. It
 *    sizes itself off the server's filter-aware `totalCount` and renders the
 *    not-yet-loaded tail as dim placeholders, so the rail's length is honest.
 *    Scrolling toward them loads pages (F7) — which is also what keeps ghost
 *    taps near the loaded frontier, so no offset-jump API is needed.
 */

const SLOT_W = 40; // px — the fixed grid unit; hit precision comes from this, not from the visual scale
const GAP = 4;
const STRIP_H = 84; // px — owner-chosen (F4); fits a 1.7x-scaled 40px slot plus padding
const PITCH = SLOT_W + GAP;
const WINDOW_BUFFER = 8; // slots rendered beyond each edge of the viewport

/** Scale falloff around the active slot — the "dent". Purely decorative. */
function scaleFor(distance: number): number {
  if (distance === 0) return 1.7;
  if (distance === 1) return 1.25;
  if (distance === 2) return 1.1;
  return 1;
}

export interface FilmstripItem {
  id: string;
  thumbUrl: string | null;
  sensitivity: Sensitivity | null;
}

export function MediaFilmstrip({
  items,
  index,
  onSelect,
  totalCount,
  onLoadMore,
  loadingMore = false,
}: {
  items: FilmstripItem[];
  index: number;
  onSelect: (index: number) => void;
  /** Gallery only — the album viewer passes none of the lazy-load trio. */
  totalCount?: number | null;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollLeft: 0, width: 0 });

  // Ghosts only ever extend the rail — never shorten it below what's actually
  // loaded (a stale/absent count must not hide real items).
  const slotCount = Math.max(items.length, totalCount ?? 0);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => setViewport({ scrollLeft: el.scrollLeft, width: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Centre the active slot whenever the index changes — driven by index only,
  // never by the user's own scrolling, so manually browsing the rail is never
  // yanked back mid-gesture.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = index * PITCH - el.clientWidth / 2 + SLOT_W / 2;
    el.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [index]);

  const [first, last] = useMemo(() => {
    if (viewport.width === 0) return [0, Math.min(slotCount, 2 * WINDOW_BUFFER)] as const;
    const firstVisible = Math.floor(viewport.scrollLeft / PITCH);
    const visibleCount = Math.ceil(viewport.width / PITCH);
    return [
      Math.max(0, firstVisible - WINDOW_BUFFER),
      Math.min(slotCount, firstVisible + visibleCount + WINDOW_BUFFER),
    ] as const;
  }, [viewport, slotCount]);

  // Page in more when the rendered window reaches the loaded frontier. Guarded
  // on `loadingMore` so a scroll that lingers near the edge doesn't fire a
  // burst of requests.
  useEffect(() => {
    if (!onLoadMore || loadingMore) return;
    if (items.length === 0 || items.length >= slotCount) return;
    if (last >= items.length) onLoadMore();
  }, [last, items.length, slotCount, onLoadMore, loadingMore]);

  if (items.length <= 1 && slotCount <= 1) return null;

  const windowed: number[] = [];
  for (let i = first; i < last; i++) windowed.push(i);

  return (
    <div
      className="shrink-0 overflow-hidden bg-black/60"
      style={{ height: STRIP_H, paddingBottom: 'env(safe-area-inset-bottom)' }}
      // The rail is a sibling of the media stage, not an overlay on it (F5) —
      // so a video's native controls sit above it and its own bottom-edge
      // exclusion zone keeps working unchanged.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={scrollerRef}
        onScroll={(e) => setViewport((v) => ({ ...v, scrollLeft: e.currentTarget.scrollLeft }))}
        className="h-full overflow-x-auto overflow-y-hidden"
        // ⚠️ iOS: `pan-x` keeps this rail from fighting the viewer image's own
        // pointer-driven swipe/pinch handlers. Unverified on real hardware.
        style={{ touchAction: 'pan-x', scrollbarWidth: 'none' }}
      >
        {/* Full-width spacer so the scrollbar and ghost proportions reflect
            the whole result set even though only a window is mounted. */}
        <div className="relative h-full" style={{ width: Math.max(0, slotCount * PITCH - GAP) }}>
          {windowed.map((i) => {
            const item = items[i];
            const distance = Math.abs(i - index);
            const scale = scaleFor(distance);
            const active = i === index;
            return (
              <button
                key={item?.id ?? `ghost:${i}`}
                type="button"
                onClick={() => onSelect(i)}
                aria-label={item ? `Item ${i + 1}` : `Item ${i + 1} — still loading`}
                aria-current={active ? 'true' : undefined}
                className="absolute top-1/2 overflow-hidden rounded-sm bg-white/10"
                style={{
                  left: i * PITCH,
                  width: SLOT_W,
                  height: SLOT_W,
                  // Scale about the slot's own centre; `translateY(-50%)` first
                  // so the growth is symmetric around the rail's midline.
                  transform: `translateY(-50%) scale(${scale})`,
                  transition: 'transform 160ms ease-out',
                  zIndex: active ? 2 : 1,
                  outline: active ? '2px solid white' : undefined,
                  outlineOffset: active ? '1px' : undefined,
                  touchAction: 'manipulation',
                }}
              >
                {item ? (
                  // Sensitive items stay blurred in the rail — this is exactly
                  // where an nsfw thumbnail would otherwise sit unguarded while
                  // the main view is busy blurring the same image.
                  // `interactive={false}`: the rail's tap belongs to navigation,
                  // and revealing happens in the main view.
                  <SensitiveOverlay
                    sensitivity={item.sensitivity}
                    blurred={item.sensitivity !== null}
                    onReveal={() => {}}
                    compact
                    interactive={false}
                    className="h-full w-full"
                  >
                    <img src={item.thumbUrl ?? undefined} alt="" className="h-full w-full object-cover" />
                  </SensitiveOverlay>
                ) : (
                  <span className="grid h-full w-full place-items-center text-white/40">
                    {loadingMore && i < items.length + 60 ? <Loader2 size={12} className="animate-spin" /> : null}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
