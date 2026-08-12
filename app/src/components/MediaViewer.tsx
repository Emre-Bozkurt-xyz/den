import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import type { MediaInfo, Tag } from '@den/shared';
import { fetchTagAutocomplete } from '../lib/tags';
import { useBackHandler } from '../lib/backStack';
import { useIsBlurred, useSensitivity } from '../lib/sensitivity';
import { SensitiveOverlay } from './SensitiveOverlay';

/** Full-screen viewer for a ready image/video. Voice messages render inline
 *  in the chat (§7: "row-style list items", not thumbnails) and never open
 *  this. `onPrev`/`onNext` (gallery only) step through the current filtered
 *  result set; `onJumpToMessage` (gallery only) navigates back to the chat.
 *  Tag list + add/remove UI (§9) only renders when `tags` is passed — the
 *  ChatView usage (tapping a bubble) doesn't wire it, only ChatGallery does.
 *
 *  Gestures (docs/archive/UI_REVAMP.md UI-6): hand-rolled Pointer Events on the
 *  *image* element — swipe left/right calls onPrev/onNext, swipe down
 *  closes, pinch and double-tap zoom/pan. The *video* element gets the same
 *  swipe-nav/swipe-close (no pinch, no double-tap-zoom — doesn't make sense
 *  for video), but only for pointerdowns starting above a bottom exclusion
 *  zone reserved for the native `controls` bar (scrubber/play/fullscreen) —
 *  a pointerdown inside that zone is left completely untouched so native
 *  control behavior is unaffected. See the UI-6 implementation notes /
 *  video-gesture-gap follow-up in docs/archive/UI_REVAMP.md for the reasoning and
 *  the caveat that the exclusion-zone height is a best guess, unverified
 *  without real touch hardware. Desktop arrow buttons and the close/jump
 *  buttons are unrelated siblings, unaffected either way. */

const MOVE_TOLERANCE = 10; // px — minimal movement before we commit to a drag/pan/axis; below this, a pointer sequence is a "tap" not a gesture.
const SWIPE_DISTANCE_THRESHOLD = 60; // px
const SWIPE_VELOCITY_THRESHOLD = 0.5; // px/ms (500px/s) — a fast short flick counts even under the distance threshold.
const CLOSE_DISTANCE_THRESHOLD = 100; // px — a bit more than the swipe threshold so a vertical wobble mid-horizontal-swipe can't also read as a close.
const CLOSE_VELOCITY_THRESHOLD = 0.5; // px/ms
const DOUBLE_TAP_MAX_DELAY_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE = 30; // px
const DOUBLE_TAP_SCALE = 2.5;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
// px — height of the bottom strip of the <video> element that's left alone
// entirely (no gesture tracking) so the native controls bar (scrubber/play/
// fullscreen) keeps completely unmodified touch behavior. "Commonly 40-56px"
// per typical browser UA stylesheets, but this varies by browser/OS and is
// a best guess, not measured against real hardware — see docs/archive/UI_REVAMP.md §8.
const VIDEO_CONTROLS_EXCLUSION_HEIGHT = 56;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Loosely keeps the zoomed image from being panned/pinched entirely off
 *  screen: bounds the translate to half the zoomed overflow relative to the
 *  image's own (unzoomed) box. Not pixel-exact "keep 1px visible" math, just
 *  a safety net so there's always a way back without hunting for the image. */
function clampTranslate(x: number, y: number, scale: number, rect: DOMRect): { x: number; y: number } {
  const maxX = Math.max(0, (rect.width * (scale - 1)) / 2);
  const maxY = Math.max(0, (rect.height * (scale - 1)) / 2);
  return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
}

type Point = { x: number; y: number };

type SwipeAction = 'prev' | 'next' | 'close' | null;

/** Pure decision function shared by both the image and video swipe/close
 *  gesture resolution: given a locked axis and the gesture's net delta/
 *  duration, decides whether it crossed the distance-or-velocity threshold
 *  for swipe-nav or swipe-close. No side effects and no element-specific
 *  state, so both surfaces resolve against the exact same thresholds
 *  (single source of truth, easy to hand-trace in isolation). */
function resolveSwipeGesture(
  axis: 'horizontal' | 'vertical' | null,
  dx: number,
  dy: number,
  dt: number,
): SwipeAction {
  if (axis === 'horizontal') {
    const vx = Math.abs(dx) / dt;
    const shouldNavigate = Math.abs(dx) > SWIPE_DISTANCE_THRESHOLD || vx > SWIPE_VELOCITY_THRESHOLD;
    if (!shouldNavigate) return null;
    return dx < 0 ? 'next' : 'prev';
  }
  if (axis === 'vertical') {
    const vy = Math.abs(dy) / dt;
    const shouldClose = dy > 0 && (dy > CLOSE_DISTANCE_THRESHOLD || vy > CLOSE_VELOCITY_THRESHOLD);
    return shouldClose ? 'close' : null;
  }
  return null;
}

/** Returns the first two values of a Map without array-indexing (keeps
 *  `noUncheckedIndexedAccess` happy and avoids an `undefined` footgun). */
function firstTwo<V>(map: Map<number, V>): [V, V] | null {
  const it = map.values();
  const a = it.next();
  if (a.done) return null;
  const b = it.next();
  if (b.done) return null;
  return [a.value, b.value];
}

function firstEntry<V>(map: Map<number, V>): [number, V] | null {
  const it = map.entries();
  const a = it.next();
  return a.done ? null : a.value;
}

type GestureState = {
  mode: 'drag' | 'pinch';
  /** Locked once a not-yet-zoomed single-pointer drag moves past MOVE_TOLERANCE; null means "not yet decided" (still could be a tap or a double-tap). */
  axis: 'horizontal' | 'vertical' | null;
  startX: number;
  startY: number;
  /** Updated on every pointermove regardless of branch, so tap-vs-gesture distance is correct even in the zoomed/panning branch, which never sets `axis`. */
  lastX: number;
  lastY: number;
  startT: number;
  /** transform.scale/x/y captured at gesture start — the base every live delta is computed on top of. */
  baseScale: number;
  baseX: number;
  baseY: number;
  pinchStartDist: number;
  pinchStartMid: Point;
  isDoubleTap: boolean;
  rect: DOMRect;
};

/** Video's gesture bookkeeping is deliberately a smaller shape than
 *  GestureState — no pinch fields, no baseScale/baseX/baseY, no
 *  isDoubleTap/rect — because video never zooms/pans and pointerdowns in
 *  the controls-exclusion zone never start a gesture at all (single
 *  pointer, swipe-nav/close only). Sharing GestureState as-is would mean
 *  either faking values for fields video never uses or widening it with
 *  optional fields everywhere the image code reads them — a smaller
 *  dedicated type is more honest about the actual (simpler) state machine. */
type VideoGestureState = {
  axis: 'horizontal' | 'vertical' | null;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startT: number;
};

export function MediaViewer({
  media,
  onClose,
  onPrev,
  onNext,
  onJumpToMessage,
  chatId,
  tags,
  onAddTag,
  onRemoveTag,
  revealOverride = false,
}: {
  media: MediaInfo;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onJumpToMessage?: () => void;
  chatId?: string;
  tags?: Tag[];
  onAddTag?: (name: string) => void;
  onRemoveTag?: (tagId: string) => void;
  /** Gallery-only (docs/MEDIA_ATTACHMENTS.md §5.5): mirrors the grid's own
   *  `galleryOverride` (the `galleryShowSensitive` setting OR a session
   *  "Show all") so the viewer doesn't contradict what the setting just
   *  promised on the tile you tapped. Optional, defaults to `false` — chat's
   *  call sites pass nothing and keep exactly today's always-blur behavior. */
  revealOverride?: boolean;
}) {
  const [transform, setTransform] = useState({ scale: 1, x: 0, y: 0 });
  const [interacting, setInteracting] = useState(false);
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const gestureRef = useRef<GestureState | null>(null);
  const lastTapRef = useRef<{ x: number; y: number; t: number } | null>(null);

  // docs/MEDIA_ATTACHMENTS.md §5.4 — the viewer can be swiped from a clean
  // item onto a blurred one, so it needs the overlay too.
  const { reveal } = useSensitivity();
  const blurred = useIsBlurred(media, revealOverride);

  // Video's swipe-nav/close drag feedback — deliberately separate state from
  // the image's `transform` (no scale component, no pinch/double-tap fields).
  const [videoTransform, setVideoTransform] = useState({ x: 0, y: 0 });
  const [videoInteracting, setVideoInteracting] = useState(false);
  const videoGestureRef = useRef<VideoGestureState | null>(null);

  // System back gesture / browser back closes the viewer (matches the X button
  // and swipe-down), instead of unwinding the underlying view. `escape: true`
  // adds the desktop Escape key, which only fires while this is the topmost
  // layer — so a viewer opened over the stack grid sheet closes itself first
  // and leaves the sheet standing (owner request, 2026-08-12).
  useBackHandler(true, onClose, { escape: true });

  // Arrow keys mirror the on-screen prev/next chevrons — the desktop
  // equivalent of the swipe gesture, and the thing every other gallery does
  // (owner request, 2026-08-12). Bound to the window rather than a focused
  // element because the viewer has no natural focus target: the image isn't
  // focusable and clicking it starts a pan gesture.
  useEffect(() => {
    if (!onPrev && !onNext) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // Never steal arrows from a text field — the gallery's viewer embeds
      // `TagEditor`, so ArrowLeft while typing a tag has to move the caret,
      // not jump to the previous photo.
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft' && onPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault();
        onNext();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onPrev, onNext]);

  // Zoom/pan/gesture bookkeeping must never leak from one item to the next.
  // This component stays mounted across prev/next (only `media` changes), so
  // a plain mount-time reset isn't enough — key the reset off media.id. Also
  // covers the fresh-mount case (initial values already match, harmless).
  useEffect(() => {
    setTransform({ scale: 1, x: 0, y: 0 });
    setInteracting(false);
    pointersRef.current.clear();
    gestureRef.current = null;
    lastTapRef.current = null;
    setVideoTransform({ x: 0, y: 0 });
    setVideoInteracting(false);
    videoGestureRef.current = null;
  }, [media.id]);

  function toggleZoom() {
    // Simple, centered toggle (not anchored to the tap point) — deliberate:
    // anchoring the zoom to the exact tap coordinate needs translate/scale
    // order math that's easy to get subtly wrong and impossible to verify
    // without a real touchscreen. Center-zoom is standard, safe UX.
    setTransform((t) => (t.scale > 1.01 ? { scale: 1, x: 0, y: 0 } : { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 }));
  }

  function onImagePointerDown(e: React.PointerEvent<HTMLImageElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setInteracting(true);
    const rect = e.currentTarget.getBoundingClientRect();

    if (pointersRef.current.size === 1) {
      const now = Date.now();
      const last = lastTapRef.current;
      const isDoubleTap =
        !!last &&
        now - last.t < DOUBLE_TAP_MAX_DELAY_MS &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_MAX_DISTANCE;
      // Consume the pending tap once matched so a third quick tap doesn't chain into another double-tap.
      lastTapRef.current = isDoubleTap ? null : { x: e.clientX, y: e.clientY, t: now };

      gestureRef.current = {
        mode: 'drag',
        axis: null,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        startT: now,
        baseScale: transform.scale,
        baseX: transform.x,
        baseY: transform.y,
        pinchStartDist: 0,
        pinchStartMid: { x: 0, y: 0 },
        isDoubleTap,
        rect,
      };
    } else if (pointersRef.current.size === 2) {
      lastTapRef.current = null; // a second finger joining cancels any pending double-tap
      const pts = firstTwo(pointersRef.current);
      if (!pts) return;
      const [p1, p2] = pts;
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      gestureRef.current = {
        mode: 'pinch',
        axis: null,
        startX: 0,
        startY: 0,
        lastX: 0,
        lastY: 0,
        startT: 0,
        baseScale: transform.scale,
        baseX: transform.x,
        baseY: transform.y,
        pinchStartDist: Math.max(dist, 1),
        pinchStartMid: mid,
        isDoubleTap: false,
        rect,
      };
    }
    // A 3rd+ simultaneous pointer is ignored — gestureRef keeps tracking whatever the first two established.
  }

  function onImagePointerMove(e: React.PointerEvent<HTMLImageElement>) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gestureRef.current;
    if (!g) return;
    if (e.cancelable) e.preventDefault();

    if (g.mode === 'pinch' && pointersRef.current.size === 2) {
      const pts = firstTwo(pointersRef.current);
      if (!pts) return;
      const [p1, p2] = pts;
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const nextScale = clamp(g.baseScale * (dist / g.pinchStartDist), MIN_SCALE, MAX_SCALE);
      const nextX = g.baseX + (mid.x - g.pinchStartMid.x);
      const nextY = g.baseY + (mid.y - g.pinchStartMid.y);
      const bounded = clampTranslate(nextX, nextY, nextScale, g.rect);
      setTransform({ scale: nextScale, x: bounded.x, y: bounded.y });
      return;
    }

    if (g.mode === 'drag') {
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      g.lastX = e.clientX;
      g.lastY = e.clientY;

      if (g.baseScale > 1.01) {
        // Zoomed: single-pointer drag pans instead of swipe-navigating/closing.
        const bounded = clampTranslate(g.baseX + dx, g.baseY + dy, g.baseScale, g.rect);
        setTransform({ scale: g.baseScale, x: bounded.x, y: bounded.y });
        return;
      }

      // Not zoomed: lock to whichever axis dominates once movement clears the tolerance, then stick to it for the rest of the gesture.
      if (!g.axis && (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE)) {
        g.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
      }
      if (g.axis === 'horizontal') {
        setTransform({ scale: 1, x: dx, y: 0 });
      } else if (g.axis === 'vertical') {
        // Only downward drag visually tracks (an upward wobble just clamps to 0 — this is a close gesture, not a pan).
        setTransform({ scale: 1, x: 0, y: Math.max(0, dy) });
      }
    }
  }

  function onImagePointerUp(e: React.PointerEvent<HTMLImageElement>) {
    pointersRef.current.delete(e.pointerId);
    const g = gestureRef.current;
    if (pointersRef.current.size === 0) setInteracting(false);
    if (!g) return;

    if (g.mode === 'pinch') {
      if (pointersRef.current.size === 1) {
        // One finger lifted, one remains: downgrade to single-pointer pan/drag, re-anchored to the remaining pointer so there's no jump.
        const entry = firstEntry(pointersRef.current);
        if (!entry) {
          gestureRef.current = null;
          return;
        }
        const [, pos] = entry;
        const settled = transform.scale <= 1.01 ? { scale: 1, x: 0, y: 0 } : transform;
        if (settled !== transform) setTransform(settled);
        gestureRef.current = {
          mode: 'drag',
          axis: null,
          startX: pos.x,
          startY: pos.y,
          lastX: pos.x,
          lastY: pos.y,
          startT: Date.now(),
          baseScale: settled.scale,
          baseX: settled.x,
          baseY: settled.y,
          pinchStartDist: 0,
          pinchStartMid: { x: 0, y: 0 },
          isDoubleTap: false,
          rect: g.rect,
        };
      } else {
        // Both fingers lifted together.
        if (transform.scale <= 1.01) setTransform({ scale: 1, x: 0, y: 0 });
        gestureRef.current = null;
      }
      return;
    }

    // g.mode === 'drag'
    if (pointersRef.current.size === 0) {
      const dt = Math.max(1, Date.now() - g.startT);
      const dx = g.lastX - g.startX;
      const dy = g.lastY - g.startY;
      const movedEnough = Math.hypot(dx, dy) > MOVE_TOLERANCE;

      if (g.isDoubleTap && !movedEnough) {
        toggleZoom();
        gestureRef.current = null;
        return;
      }

      if (g.baseScale > 1.01) {
        // Was panning a zoomed image — position already committed live during pointermove, nothing further to resolve.
        gestureRef.current = null;
        return;
      }

      // Shared with video's onVideoPointerUp below — see resolveSwipeGesture.
      const action = resolveSwipeGesture(g.axis, dx, dy, dt);
      if (action === 'next' && onNext) onNext();
      else if (action === 'prev' && onPrev) onPrev();
      if (action === 'close') {
        onClose();
      } else {
        // Snap back (covers both "swipe didn't cross threshold" and the plain-tap
        // no-axis-locked case); a real navigation also gets a fresh reset from the media.id effect above.
        setTransform({ scale: 1, x: 0, y: 0 });
      }
      gestureRef.current = null;
    }
  }

  function onImagePointerCancel(e: React.PointerEvent<HTMLImageElement>) {
    // Browser-interrupted gesture (e.g. a system edge-swipe took over). Abort
    // without side effects — no navigate/close/zoom-toggle — just snap any
    // in-progress swipe back to identity, or leave an established zoom/pan as-is.
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size === 0) {
      setInteracting(false);
      gestureRef.current = null;
      setTransform((t) => (t.scale <= 1.01 ? { scale: 1, x: 0, y: 0 } : t));
    }
  }

  // --- Video: swipe-nav (prev/next) + swipe-down-to-close only. No pinch,
  // no double-tap-zoom (video doesn't need zoom — its own controls already
  // occupy the interaction budget). Gated on a bottom exclusion zone so the
  // native controls bar keeps completely untouched touch behavior — see the
  // file-level comment and docs/archive/UI_REVAMP.md §8 for the reasoning/caveats.

  function onVideoPointerDown(e: React.PointerEvent<HTMLVideoElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    if (relativeY > rect.height - VIDEO_CONTROLS_EXCLUSION_HEIGHT) {
      // Pointerdown lands in the native-controls exclusion zone: don't call
      // setPointerCapture, don't start gesture tracking, don't preventDefault
      // — leave this pointer's entire event stream for the browser's native
      // scrubber/play/fullscreen handling, completely unmodified.
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setVideoInteracting(true);
    videoGestureRef.current = {
      axis: null,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      startT: Date.now(),
    };
  }

  function onVideoPointerMove(e: React.PointerEvent<HTMLVideoElement>) {
    const g = videoGestureRef.current;
    // No tracked gesture means this pointer's pointerdown either started in
    // the exclusion zone or was never ours to begin with — do nothing, and
    // critically, don't preventDefault, so native control dragging (e.g. the
    // scrubber) is completely unaffected.
    if (!g) return;
    if (e.cancelable) e.preventDefault();
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    g.lastX = e.clientX;
    g.lastY = e.clientY;

    if (!g.axis && (Math.abs(dx) > MOVE_TOLERANCE || Math.abs(dy) > MOVE_TOLERANCE)) {
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    if (g.axis === 'horizontal') {
      setVideoTransform({ x: dx, y: 0 });
    } else if (g.axis === 'vertical') {
      setVideoTransform({ x: 0, y: Math.max(0, dy) }); // only downward tracks — matches the image's close gesture
    }
  }

  function onVideoPointerUp(_e: React.PointerEvent<HTMLVideoElement>) {
    const g = videoGestureRef.current;
    videoGestureRef.current = null;
    setVideoInteracting(false);
    // No tracked gesture: this pointerdown started in the exclusion zone, so
    // there's nothing of ours to resolve — the native control (play/pause
    // tap, scrubber release, etc.) already handled its own click/behavior.
    if (!g) return;

    const dt = Math.max(1, Date.now() - g.startT);
    const dx = g.lastX - g.startX;
    const dy = g.lastY - g.startY;
    const action = resolveSwipeGesture(g.axis, dx, dy, dt);
    if (action === 'next' && onNext) onNext();
    else if (action === 'prev' && onPrev) onPrev();
    if (action === 'close') {
      onClose();
    } else {
      setVideoTransform({ x: 0, y: 0 });
    }
  }

  function onVideoPointerCancel(_e: React.PointerEvent<HTMLVideoElement>) {
    // Browser-interrupted gesture — abort with no side effects, same as the image's cancel handler.
    videoGestureRef.current = null;
    setVideoInteracting(false);
    setVideoTransform({ x: 0, y: 0 });
  }

  if (media.status !== 'ready' || !media.url) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {/* `z-10` + an opaque-ish fill: on a landscape image the media used to
          run edge to edge under this button, leaving a barely-visible
          `bg-white/10` circle floating on bright pixels and no obvious way
          out (owner report, 2026-08-12). The desktop stage padding below now
          keeps media clear of it entirely; the stronger fill covers the
          mobile full-bleed case, where the overlap is unavoidable. */}
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 z-10 grid h-9 w-9 place-items-center rounded-pill bg-black/60 text-white ring-1 ring-white/25 transition-colors hover:bg-black/80"
        style={{ top: 'calc(env(safe-area-inset-top) + 1rem)', touchAction: 'manipulation' }}
      >
        <X size={18} />
      </button>

      {onJumpToMessage && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onJumpToMessage();
          }}
          className="absolute left-4 top-4 z-10 rounded-pill bg-black/60 px-3 py-1.5 text-sm text-white ring-1 ring-white/25 transition-colors hover:bg-black/80"
          style={{ top: 'calc(env(safe-area-inset-top) + 1rem)', touchAction: 'manipulation' }}
        >
          Jump to message
        </button>
      )}

      {onPrev && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label="Previous"
          className="absolute left-2 top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-pill bg-black/60 text-white ring-1 ring-white/25 transition-colors hover:bg-black/80"
          style={{ touchAction: 'manipulation' }}
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {onNext && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="Next"
          className="absolute right-2 top-1/2 z-10 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-pill bg-black/60 text-white ring-1 ring-white/25 transition-colors hover:bg-black/80"
          style={{ touchAction: 'manipulation' }}
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* Mobile stays full-bleed (edge-to-edge is right on a phone). Desktop
          gets a padded, size-capped stage instead of filling the entire
          monitor — the owner's "album and image views could be smaller, they
          cover the whole screen and feel too much" (2026-08-12). The padding
          is also what keeps landscape media out from under the close button
          and the prev/next chevrons, which sit in the margins it creates. */}
      <div className="flex flex-1 items-center justify-center overflow-hidden md:px-20 md:py-16">
        <div className="flex h-full w-full items-center justify-center md:max-h-[80vh] md:max-w-[1100px]">
        {/* When `media.sensitivity` is null (the overwhelming majority case)
            this renders `children` completely unwrapped — zero DOM/layout
            change from before this feature. When sensitive, the wrapper is
            given an explicit h-full/w-full box (not just max-h-full) so the
            image/video's own percentage-based max-h-full/max-w-full still
            resolves against a definite containing-block height instead of an
            auto-sized one — otherwise object-contain's scale-down clamp would
            silently stop working for exactly the items that most need it
            correctly framed (the blur pill sitting over an unclamped giant
            image). */}
        <SensitiveOverlay
          sensitivity={media.sensitivity}
          blurred={blurred}
          onReveal={() => reveal(media.id)}
          className="flex h-full w-full items-center justify-center"
        >
          {media.kind === 'image' ? (
            <img
              src={media.url}
              alt=""
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={onImagePointerDown}
              onPointerMove={onImagePointerMove}
              onPointerUp={onImagePointerUp}
              onPointerCancel={onImagePointerCancel}
              className="max-h-full max-w-full object-contain"
              style={{
                touchAction: 'none',
                WebkitUserSelect: 'none',
                userSelect: 'none',
                transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
                transition: interacting ? 'none' : 'transform 200ms ease-out',
                cursor: transform.scale > 1.01 ? 'grab' : undefined,
              }}
            />
          ) : (
            // Video gets swipe-nav (prev/next) + swipe-down-to-close, gated to
            // pointerdowns that start above VIDEO_CONTROLS_EXCLUSION_HEIGHT
            // from the bottom of the element — a pointerdown inside that zone
            // is left completely alone (see onVideoPointerDown) so the native
            // `controls` bar (scrubber/play/fullscreen) keeps unmodified touch
            // behavior. No pinch-zoom, no double-tap-zoom — out of scope for
            // video (see file-level comment / docs/archive/UI_REVAMP.md §8).
            <video
              key={media.id}
              src={media.url}
              poster={media.thumbUrl ?? undefined}
              controls
              autoPlay
              className="max-h-full max-w-full"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={onVideoPointerDown}
              onPointerMove={onVideoPointerMove}
              onPointerUp={onVideoPointerUp}
              onPointerCancel={onVideoPointerCancel}
              style={{
                transform: `translate(${videoTransform.x}px, ${videoTransform.y}px)`,
                transition: videoInteracting ? 'none' : 'transform 200ms ease-out',
              }}
            />
          )}
        </SensitiveOverlay>
        </div>
      </div>

      {tags && onAddTag && onRemoveTag && (
        <div onClick={(e) => e.stopPropagation()} className="shrink-0 bg-black/60 p-3">
          <TagEditor chatId={chatId} tags={tags} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />
        </div>
      )}
    </div>
  );
}

/** Palettes for `TagEditor`'s two homes. `dark` is the original: fixed dark
 *  literals because the editor sits on `MediaViewer`'s always-black backdrop
 *  regardless of app theme, where `bg-surface-raised` would be white in light
 *  mode (docs/archive/UI_REVAMP.md UI-5/UI-6 precedent). `surface` is for app
 *  chrome that follows the theme — the composer's attachment sheet
 *  (docs/MEDIA_ATTACHMENTS.md §5.2). Added instead of wrapping the editor in
 *  yet another `bg-neutral-900` box the way ChatGallery's MobileTagSheet
 *  does; a third copy of that hack was the wrong direction. */
const TAG_EDITOR_TONES = {
  dark: {
    chip: 'bg-white/15 text-white hover:bg-white/20',
    chipRemove: 'text-white/60 hover:text-white',
    input:
      'border-white/20 bg-white/10 text-white placeholder:text-white/40 focus:border-white/40',
    submit: 'bg-indigo-600 text-white hover:bg-indigo-500 disabled:hover:bg-indigo-600',
    suggestions: 'bg-neutral-900 shadow-lg',
    suggestion: 'text-white hover:bg-white/10',
    suggestionCount: 'text-white/40',
  },
  surface: {
    chip: 'bg-surface-sunken text-text-primary hover:bg-border',
    chipRemove: 'text-text-muted hover:text-text-primary',
    input:
      'border-border bg-surface text-text-primary placeholder:text-text-muted focus:border-accent',
    submit: 'bg-accent text-white hover:bg-accent-hover disabled:hover:bg-accent',
    suggestions: 'border border-border bg-surface-raised shadow-strong',
    suggestion: 'text-text-primary hover:bg-surface-sunken',
    suggestionCount: 'text-text-muted',
  },
} as const;

export type TagEditorTone = keyof typeof TAG_EDITOR_TONES;

export function TagEditor({
  chatId,
  tags,
  onAddTag,
  onRemoveTag,
  tone = 'dark',
}: {
  chatId: string | undefined;
  tags: Tag[];
  onAddTag: (name: string) => void;
  onRemoveTag: (tagId: string) => void;
  /** Defaults to `dark` so every pre-existing call site (MediaViewer,
   *  ChatGallery's panels) is untouched. */
  tone?: TagEditorTone;
}) {
  const t = TAG_EDITOR_TONES[tone];
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState<Tag[]>([]);

  useEffect(() => {
    if (!chatId || !draft.trim()) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void fetchTagAutocomplete(chatId, draft.trim()).then((res) => {
        if (!cancelled) setSuggestions(res.tags);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [chatId, draft]);

  function submit(name: string) {
    if (!name.trim()) return;
    onAddTag(name.trim());
    setDraft('');
    setSuggestions([]);
  }

  // Colors come from TAG_EDITOR_TONES above: `dark` keeps the original fixed
  // literals (docs/archive/UI_REVAMP.md UI-5 precedent — this panel sits on
  // MediaViewer's always-black/90 backdrop regardless of the app's light/dark
  // mode, so `bg-surface-raised` would be white-on-white in light mode);
  // `surface` follows the theme tokens for in-app chrome. Radius always comes
  // from the shared token scale (rounded-sm/rounded-pill).
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className={'flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs transition-colors ' + t.chip}
          >
            {tag.name}
            <button
              onClick={() => onRemoveTag(tag.id)}
              aria-label={`Remove tag ${tag.name}`}
              className={'transition-colors ' + t.chipRemove}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a tag — spaces become hyphens"
            className={'min-w-0 flex-1 rounded-sm border px-2.5 py-1.5 text-sm outline-none ' + t.input}
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className={
              'flex shrink-0 items-center gap-1 rounded-sm px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ' +
              t.submit
            }
          >
            <Plus size={14} />
            Add
          </button>
        </form>
        {suggestions.length > 0 && (
          <div className={'absolute bottom-full left-0 mb-1 w-full overflow-hidden rounded-sm ' + t.suggestions}>
            {suggestions.map((s) => (
              <button
                key={s.id}
                onClick={() => submit(s.name)}
                className={
                  'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ' +
                  t.suggestion
                }
              >
                <span>{s.name}</span>
                <span className={t.suggestionCount}>{s.usageCount}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
