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

const SLOT_W = 36; // px — the fixed grid unit; hit precision comes from this, not from the visual scale
const GAP = 4;
// Retuned down from 40/84/1.7 after the owner saw it on a phone: the rail was
// taking too much of the image, and the magnification was overstated.
const STRIP_H = 64; // px — fits a 1.35x-scaled 36px slot plus padding
const PITCH = SLOT_W + GAP;
const WINDOW_BUFFER = 8; // slots rendered beyond each edge of the viewport
/** How long the rail must sit still near the frontier before asking for the
 *  next page. Long enough that a fling across the whole rail requests
 *  nothing, short enough to feel automatic when you stop and look. */
const LOAD_MORE_SETTLE_MS = 350;
/** How long the rail must sit still before the centred slot becomes the
 *  selection. Short enough to feel immediate, long enough that scrubbing past
 *  ten slots fetches one full-size image instead of ten. */
const SELECT_SETTLE_MS = 140;
/** How long a centring scroll we initiated is treated as "not the user".
 *  Covers a smooth-scroll animation; a real gesture during the window simply
 *  commits on the next settle instead. */
const PROGRAMMATIC_SCROLL_MS = 500;

/** Scale falloff around the active slot — the "dent". Purely decorative. */
function scaleFor(distance: number): number {
  if (distance === 0) return 1.35;
  if (distance === 1) return 1.15;
  if (distance === 2) return 1.05;
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
  // Read through a ref so an unstable parent closure can't retrigger the
  // settle effects (the same footgun that made auto-paging run away).
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  // Scroll events fire far faster than paint on a phone, and each one would
  // otherwise re-render a row of blurred, transformed thumbnails. Coalesce to
  // one state write per frame — same posture as useKeyboardInset's rAF
  // coalescing (docs/IOS_KEYBOARD.md).
  const scrollRafRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const next = e.currentTarget.scrollLeft;
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setViewport((v) => (v.scrollLeft === next ? v : { ...v, scrollLeft: next }));
    });
  }

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

  // Half-gutters so the FIRST and LAST slots can actually reach the centre.
  // Without them the rail can't scroll far enough for slot 0 to be centred,
  // `scrollLeft: 0` maps to some positive index, and "scroll picks the centred
  // slot" oscillates forever at the ends. With them the maths collapses to
  // `centred = round(scrollLeft / PITCH)` and `scrollLeft(i) = i * PITCH`,
  // which are exact inverses — that's what makes the loop below converge.
  const sidePad = viewport.width > 0 ? Math.max(0, (viewport.width - SLOT_W) / 2) : 0;

  /** Which slot is under the rail's centre line right now. */
  const centredSlot = useMemo(() => {
    if (viewport.width === 0 || slotCount === 0) return index;
    return Math.min(slotCount - 1, Math.max(0, Math.round(viewport.scrollLeft / PITCH)));
  }, [viewport, slotCount, index]);

  // Centre the active slot when the index changes from OUTSIDE the rail
  // (swipe on the image, arrow keys, a tap on a slot) — and also right after
  // the rail commits its own selection, where re-centring is exactly the
  // snap-into-place a phone gallery does. It converges rather than fighting
  // the user because the target position maps back to the same slot.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // Mark the scroll that follows as ours. Without this, opening the viewer
    // deep in a list would commit a spurious selection: the rail mounts at
    // scrollLeft 0 (i.e. "slot 0 is centred") a frame before this scroll
    // starts, and the settle effect below would happily act on that and drag
    // the viewer back to the first item.
    programmaticUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_MS;
    el.scrollTo({ left: index * PITCH, behavior: 'smooth' });
  }, [index]);

  // Scrolling the rail selects the centred slot — the whole point of a
  // gallery scrubber (owner: "scrolling should auto focus on the centered
  // slot, phone gallery style").
  //
  // Committed on settle rather than live, deliberately: the main view shows
  // FULL-SIZE media, so selecting on every scroll frame would fetch a
  // full-size image per slot crossed. The rail's own highlight follows the
  // finger immediately (it reads `centredSlot`, not `index`), so the gesture
  // still feels live — it's only the expensive part that waits for you to
  // stop. Ghost slots are never committed: the viewer would have nothing to
  // show, so the selection stays put until that page lands.
  const programmaticUntilRef = useRef(0);
  useEffect(() => {
    if (centredSlot === index) return;
    if (centredSlot >= items.length) return;
    const timer = window.setTimeout(() => {
      // A centring scroll we started is still in flight — its intermediate
      // positions are not a user choice.
      if (Date.now() < programmaticUntilRef.current) return;
      onSelectRef.current(centredSlot);
    }, SELECT_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [centredSlot, index, items.length]);

  const [first, last] = useMemo(() => {
    if (viewport.width === 0) return [0, Math.min(slotCount, 2 * WINDOW_BUFFER)] as const;
    const firstVisible = Math.floor(viewport.scrollLeft / PITCH);
    const visibleCount = Math.ceil(viewport.width / PITCH);
    return [
      Math.max(0, firstVisible - WINDOW_BUFFER),
      Math.min(slotCount, firstVisible + visibleCount + WINDOW_BUFFER),
    ] as const;
  }, [viewport, slotCount]);

  // Page in more when the rail settles with its window past the loaded
  // frontier.
  //
  // The first version of this fired as soon as the window reached the
  // frontier, guarded only by `loadingMore` — and that took the tab out on a
  // phone. Three things compounded: `onLoadMore` is a fresh closure on every
  // parent render so this effect re-ran constantly; the caller's in-flight
  // flag doesn't flip synchronously, so a fling could fire several page
  // requests before any reported itself as loading; and every loaded page
  // also lands in the gallery's un-virtualized grid behind the viewer. One
  // flick of the rail could therefore walk the whole gallery into memory.
  //
  // Two guards, both necessary:
  //  - `requestedAtRef` — at most one request per distinct loaded length, so
  //    a repeat can only happen after `items` genuinely grew.
  //  - the settle delay — the effect's cleanup cancels the pending timer on
  //    every scroll-driven change, so a fling across the rail requests
  //    nothing; only stopping near the frontier does. `onLoadMore` is read
  //    through a ref so an unstable closure identity can't retrigger this.
  const requestedAtRef = useRef(-1);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  useEffect(() => {
    if (!onLoadMoreRef.current || loadingMore) return;
    if (items.length === 0 || items.length >= slotCount) return;
    if (last < items.length) return;
    if (requestedAtRef.current === items.length) return;
    const timer = window.setTimeout(() => {
      requestedAtRef.current = items.length;
      onLoadMoreRef.current?.();
    }, LOAD_MORE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [last, items.length, slotCount, loadingMore]);

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
        onScroll={onScroll}
        className="h-full overflow-x-auto overflow-y-hidden"
        // ⚠️ iOS: `pan-x` keeps this rail from fighting the viewer image's own
        // pointer-driven swipe/pinch handlers. Unverified on real hardware.
        style={{ touchAction: 'pan-x', scrollbarWidth: 'none', paddingLeft: sidePad, paddingRight: sidePad }}
      >
        {/* Full-width spacer so the scrollbar and ghost proportions reflect
            the whole result set even though only a window is mounted. */}
        <div className="relative h-full" style={{ width: Math.max(0, slotCount * PITCH - GAP) }}>
          {windowed.map((i) => {
            const item = items[i];
            // Distance from the CENTRED slot, not the committed index, so the
            // dent tracks the finger during a scrub instead of lagging behind
            // the settle delay.
            const distance = Math.abs(i - centredSlot);
            const scale = scaleFor(distance);
            // The ring follows the centred slot too, so mid-scrub the rail
            // reads as "this is what you're about to land on" rather than
            // pointing at whatever was selected before the gesture started.
            const active = i === centredSlot;
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
