import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { CheckSquare, Copy, EyeOff, Pencil, Plus, Reply, Star, Trash2 } from 'lucide-react';
import { ReactionLimits, type MeResponse, type Message } from '@den/shared';
import { formatSendTime } from '../lib/datetime';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useBackHandler } from '../lib/backStack';
import { useSensitivity } from '../lib/sensitivity';

/**
 * iMessage-style "focus" action menu (UI-8d request F,
 * docs/archive/UI8_CHAT_INSTAGRAM.md) — replaces the old bottom-sheet action menu.
 * The tapped/clicked bubble visually lifts in place, the rest of the screen
 * dims + blurs behind it, and an action panel drops in just below (or above,
 * near the bottom of the viewport) it. Opens from the three-dots (desktop,
 * UI-8c) or long-press (mobile, unchanged from before this stage).
 *
 * **Hand-rolled, no animation library.** The "lift" is a `cloneNode(true)`
 * of the *real* bubble DOM node (captured via `ChatView`'s `messageRefs`),
 * mounted into a `position: fixed` host at the source bubble's live
 * `DOMRect`, then eased to a slightly-scaled resting transform — a classic
 * shared-element trick without needing to re-implement bubble/media/voice
 * rendering a second time here. The clone is decorative only
 * (`pointer-events: none`, interactive descendants disabled) — it is never a
 * second live control surface.
 *
 * **The rect is re-measured, not frozen.** The `rect` prop is only the opening
 * measurement; `useSourceRect` below re-reads the source node whenever the
 * viewport or the node itself moves. It has to: opening this menu blurs the
 * composer, which dismisses the soft keyboard, which on Android grows the
 * *layout* viewport and re-lays out the whole message list underneath. With a
 * frozen rect the clone stayed put while the real bubble slid down behind the
 * dim, and the user saw the same message twice in two places (owner report,
 * 2026-08-23). The source node is also hidden for the menu's lifetime
 * (`useHiddenSource`) so the two can never be on screen together at all —
 * before, the clone covering its own original exactly was the only reason
 * nobody noticed the duplicate.
 */

const LIFT_SCALE = 1.03;
const TRANSITION_MS = 150;
const PANEL_STAGGER_MS = 60; // panel starts easing in slightly after the bubble begins lifting — a small stagger, not a strict "wait for the bubble to finish"
const VIEWPORT_MARGIN = 16; // px — keeps the panel off the screen edges; "clean margins", never edge-to-edge
const PANEL_SIDE_BIAS = 0.32; // 0 = dead center, 1 = centered on the bubble; a gentle lean toward the message's side
// Best-effort estimate of the panel's rendered height (quick-emoji row +
// send-time header + Reply + up to 3 more action rows), used only to decide
// whether it should drop *below* or *above* the lifted bubble. Not measured
// against real content sizes or a real device — see the UI-8d notes in
// docs/archive/UI_REVAMP.md §5 for why this is a judgment call, same spirit as
// MediaViewer's VIDEO_CONTROLS_EXCLUSION_HEIGHT. Bumped from 200 when the
// quick-emoji row and Reply row were added (post-MVP reactions/replies).
const PANEL_ESTIMATED_HEIGHT = 300;
// How long after opening to keep polling the source bubble's position. Covers
// the soft keyboard's slide-out and the reflow that follows it; matches the
// constant of the same name in ChatView, which sizes the same phenomenon.
const KEYBOARD_SETTLE_MS = 400;

// Deliberately no `backdrop-filter` here even though it's supported: on a
// real Android PWA it was observed compositing incorrectly against the
// scrolling message list underneath — everything above the focused bubble
// dimmed correctly, everything below (still updating/repainting) rendered
// through the blur layer at full opacity, on top of the panel. A known
// Android Chrome/WebView backdrop-filter-vs-scrolling-content bug, not
// something feature-detection catches. Flat dim only, no blur — see the
// Decision Log (BACKBONE §15) for the writeup (2026-07-22).

/**
 * The source bubble's *live* on-screen rect. Seeded with the measurement taken
 * when the menu opened, then re-read whenever anything that could move the
 * bubble happens:
 *
 *  - `visualViewport` resize/scroll — iOS never resizes the layout viewport for
 *    the keyboard, so this is the only signal there (same reasoning as
 *    `useKeyboardInset`, docs/IOS_KEYBOARD.md; note that hook is hard-gated to
 *    iOS and so can't be reused here — Android needs the window/observer path
 *    below instead).
 *  - `window` resize — Android/Chrome *does* resize the layout viewport for the
 *    keyboard, which is the case that produced the original report.
 *  - a `ResizeObserver` on the node itself and on `document.body` — covers the
 *    list reflowing for reasons that aren't the keyboard at all (an image
 *    finishing load above the bubble, a reaction pill wrapping, rotation).
 *
 * Reads are coalesced into one per animation frame, and the returned object is
 * only replaced when a value actually changed, so a stream of no-op viewport
 * events doesn't re-render the menu.
 */
function useSourceRect(sourceEl: HTMLElement, initial: DOMRect) {
  const [rect, setRect] = useState<DOMRect>(initial);

  useEffect(() => {
    let rafId: number | null = null;

    function measure() {
      rafId = null;
      const next = sourceEl.getBoundingClientRect();
      setRect((cur) =>
        cur.top === next.top && cur.left === next.left && cur.width === next.width && cur.height === next.height
          ? cur
          : next,
      );
    }

    function schedule() {
      if (rafId !== null) return; // already queued for this frame
      rafId = requestAnimationFrame(measure);
    }

    const vv = window.visualViewport;
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(sourceEl);
    ro.observe(document.body);

    // The keyboard's retraction is an animation, not an event: Android fires a
    // handful of resizes as it slides away and the list settles a frame or two
    // after the last one. A short poll over that window costs nothing (it stops
    // well before the menu is likely to be dismissed) and removes the whole
    // class of "settled one frame after we stopped listening" misses.
    const settle = window.setInterval(schedule, 50);
    const stopSettle = window.setTimeout(() => window.clearInterval(settle), KEYBOARD_SETTLE_MS);

    return () => {
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro.disconnect();
      window.clearInterval(settle);
      window.clearTimeout(stopSettle);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [sourceEl]);

  return rect;
}

/**
 * Hides the real bubble for as long as the menu is up, so it and the lifted
 * clone can never both be on screen (see the file header). `visibility` rather
 * than `display`, deliberately — it keeps the node's box, so the list's scroll
 * height doesn't change underneath the reader, and `useSourceRect` can keep
 * measuring it.
 *
 * Restored on unmount even if the node has since been detached (a
 * `message.deleted` frame arriving while the menu is open), which is harmless.
 */
function useHiddenSource(sourceEl: HTMLElement) {
  useEffect(() => {
    const previous = sourceEl.style.visibility;
    sourceEl.style.visibility = 'hidden';
    return () => {
      sourceEl.style.visibility = previous;
    };
  }, [sourceEl]);
}

export function MessageFocusMenu({
  message,
  rect: initialRect,
  sourceEl,
  me,
  onClose,
  onReply,
  onReact,
  onCopy,
  onSelect,
  onDelete,
  onEdit,
  onDiscard,
  onFavorite,
  favorited,
}: {
  message: Message;
  /** Captured via `messageRefs.get(id).getBoundingClientRect()` at the
   *  moment the menu opens (`ChatView`'s `openActionMenu`) — the on-screen
   *  position the lift animates *from*. Only the opening measurement: from
   *  there on the live rect comes from `useSourceRect`, see the file header. */
  rect: DOMRect;
  /** The real bubble DOM node the lifted clone is copied from. */
  sourceEl: HTMLElement;
  me: MeResponse;
  onClose: () => void;
  /** Post-MVP: sets `ChatView`'s `replyingTo`. The caller (`ChatView`) also
   *  closes the menu — this component doesn't call `onClose` itself, mirroring
   *  how `onCopy`/`onSelect`/`onDelete` already work below. */
  onReply: (m: Message) => void;
  /** Post-MVP: toggles `emoji` on `m` (quick-emoji row). Same "caller closes
   *  the menu" contract as `onReply`/`onCopy`/`onSelect`/`onDelete`. */
  onReact: (m: Message, emoji: string) => void;
  onCopy: (m: Message) => void;
  onSelect: (m: Message) => void;
  onDelete: (m: Message) => void;
  /** docs/MESSAGE_EDIT.md — sets `ChatView`'s `editing`. Same caller-closes
   *  contract as every other row here. */
  onEdit: (m: Message) => void;
  /** docs/RECEIPTS.md §5.4 — removes a `failed:` bubble for good. Same
   *  caller-closes contract as every other row here. */
  onDiscard: (m: Message) => void;
  /** docs/GIF_FAVORITES.md §8.1 — undefined unless this message is an inline
   *  GIF *and* GIFs are configured on this server, in which case no row
   *  renders. This is the mobile half of the affordance; desktop reaches the
   *  same action through the hover bar's star (`MessageActions`). */
  onFavorite?: (m: Message) => void;
  favorited?: boolean;
}) {
  const rect = useSourceRect(sourceEl, initialRect);
  useHiddenSource(sourceEl);
  const reducedMotion = useReducedMotion();
  // System back gesture / browser back dismisses the menu (matches Escape and
  // the backdrop tap), instead of unwinding the underlying view.
  useBackHandler(true, onClose, { escape: true });
  const [revealed, setRevealed] = useState(reducedMotion);
  const [panelRevealed, setPanelRevealed] = useState(reducedMotion);
  const cloneHostRef = useRef<HTMLDivElement>(null);
  const mine = message.senderId === me.id;
  // docs/RECEIPTS.md §5.4 — a failed send never reached the server (no real
  // id, no reactions/edit/etc. to act on), so its menu drops straight to a
  // single Discard row instead of the full action set below.
  const failed = message.id.startsWith('failed:');
  // docs/MEDIA_ATTACHMENTS.md §5.4/§5.8 — every marked item this message
  // carries (single media or an album), so "Hide again" can drop all of them
  // out of the app-session reveal set at once rather than one at a time.
  const { hide } = useSensitivity();
  const sensitiveMediaIds = message.media.filter((m) => m.sensitivity !== null).map((m) => m.id);

  // Two-phase mount: render at the captured rect/scale-1 first, then flip to
  // the resting transform one frame later so the browser actually has
  // something to transition *from* (a CSS transition needs a real "before"
  // state, not just a final one) — same technique MediaViewer uses for its
  // `interacting` toggle. Reduced-motion skips straight to the resting state.
  useEffect(() => {
    if (reducedMotion) return;
    const raf = requestAnimationFrame(() => setRevealed(true));
    const t = window.setTimeout(() => setPanelRevealed(true), PANEL_STAGGER_MS);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [reducedMotion]);

  // The shared-element clone: copied once from the live bubble, stripped of
  // interactivity, and cleaned up on close/unmount. Cloning (rather than
  // re-rendering the message a second time from scratch) means this works
  // uniformly for text, image/video, and voice bubbles without duplicating
  // MessageBlockRow/MediaBubble/VoiceMessage's rendering logic here.
  useEffect(() => {
    const host = cloneHostRef.current;
    if (!host) return;
    const clone = sourceEl.cloneNode(true) as HTMLElement;
    // Cloning duplicates `id` attributes, which would collide with the
    // original still mounted behind the backdrop — strip them.
    if (clone.id) clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    // Decorative only: never a second live control surface (voice
    // play/seek, etc.) sitting on top of the real one.
    clone.querySelectorAll('button, input, textarea, select, audio, video, [tabindex]').forEach((el) => {
      el.setAttribute('tabindex', '-1');
      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) el.disabled = true;
      if (el instanceof HTMLAudioElement || el instanceof HTMLVideoElement) el.removeAttribute('autoplay');
    });
    clone.style.pointerEvents = 'none';
    clone.style.margin = '0';
    // `useHiddenSource` runs first (hooks fire in declaration order), so the
    // node this was copied from already carries `visibility: hidden` inline —
    // and `cloneNode(true)` copies inline styles. Undo it on the copy, or the
    // lift is invisible and the menu appears to float over nothing.
    clone.style.visibility = 'visible';
    // Likewise for a swipe-to-reply offset left painted on the block: the
    // clone is positioned by its own captured rect, so an inherited
    // `translateX` would double-count and offset the lift sideways.
    clone.style.transform = 'none';
    clone.style.transition = 'none';
    host.appendChild(clone);
    return () => {
      host.removeChild(clone);
    };
  }, [sourceEl]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Recomputed on every render, which `useSourceRect` now guarantees happens
  // whenever the viewport changes — so the below/above decision is made against
  // the viewport the panel will actually land in, not the one that existed when
  // a keyboard was still up.
  const viewportH = window.innerHeight;
  const spaceBelow = viewportH - rect.bottom;
  const spaceAbove = rect.top;
  const panelFitsBelow = spaceBelow >= PANEL_ESTIMATED_HEIGHT + VIEWPORT_MARGIN;
  const panelFitsAbove = spaceAbove >= PANEL_ESTIMATED_HEIGHT + VIEWPORT_MARGIN;
  // Prefer below (matches the reference and reads naturally under the
  // bubble); fall back to above if below is cramped; if *neither* fits
  // (a very short viewport) default to below anyway rather than nudging the
  // bubble itself — see the file-header note on PANEL_ESTIMATED_HEIGHT.
  const panelSide: 'below' | 'above' = !panelFitsBelow && panelFitsAbove ? 'above' : 'below';

  const bubbleStyle: CSSProperties = {
    position: 'fixed',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    transformOrigin: 'center',
    transform: revealed ? `translateZ(0) scale(${LIFT_SCALE})` : 'translateZ(0) scale(1)',
    // `top`/`left` are deliberately left out of the transition: when the list
    // reflows under a retracting keyboard the clone should arrive where the
    // bubble now is, not chase it across the screen a beat behind. Only the
    // lift's own scale animates.
    transition: reducedMotion ? 'none' : `transform ${TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1)`,
    zIndex: 61,
    pointerEvents: 'none',
  };

  // Lean the panel gently toward the side the message is on (right for
  // `mine`, left for others) rather than dead-centering it — a small bias
  // reads as "this belongs to that message" without squishing the panel
  // against the screen edge (user feedback, 2026-07-22). `PANEL_SIDE_BIAS`
  // is the fraction of the way from screen center toward the bubble's own
  // center; kept low so it's a lean, not a snap. Width mirrors the old
  // `min(85vw, 320px)` so it can be positioned and clamped in JS.
  const viewportW = window.innerWidth;
  const panelW = Math.min(0.85 * viewportW, 320);
  const bubbleCenterX = rect.left + rect.width / 2;
  const biasedCenterX = viewportW / 2 + (bubbleCenterX - viewportW / 2) * PANEL_SIDE_BIAS;
  const panelLeft = Math.min(
    viewportW - panelW - VIEWPORT_MARGIN,
    Math.max(VIEWPORT_MARGIN, biasedCenterX - panelW / 2),
  );

  const panelStyle: CSSProperties = {
    position: 'fixed',
    left: panelLeft,
    ...(panelSide === 'below' ? { top: rect.bottom + 8 } : { bottom: viewportH - rect.top + 8 }),
    width: panelW,
    maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
    opacity: panelRevealed ? 1 : 0,
    transform: panelRevealed ? 'translateZ(0) translateY(0) scale(1)' : `translateZ(0) translateY(${panelSide === 'below' ? -6 : 6}px) scale(0.98)`,
    transition: reducedMotion ? 'none' : `opacity ${TRANSITION_MS}ms ease-out, transform ${TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1)`,
    zIndex: 62,
    paddingBottom: 'env(safe-area-inset-bottom)',
  };

  // Portalled to `document.body`, and — this is the part that actually
  // matters — given an explicit `zIndex` on this outermost wrapper itself,
  // not just on its children. `position: fixed` always creates a new
  // stacking context (CSS2.1 spec), even at `z-index: auto`; but an "auto"
  // stacking context is painted at its parent's z-index:0 layer, same
  // layer as any other unpositioned content. Meanwhile every message block
  // (`MessageBlockRow`) sets `position: relative; z-index: 10` on itself —
  // a plain positive z-index in the SAME parent (body-level) stacking
  // context this wrapper lives in. z-index:10 paints later than an
  // z-index:auto context regardless of what z-index values exist *inside*
  // that auto context (the backdrop/clone/panel's 50/61/62 only order
  // things relative to each other, never against this wrapper's siblings)
  // — so every message bubble on the page won automatically, confirmed via
  // `elementsFromPoint` in real testing (Chromium and reported in Firefox
  // too — this is spec-correct behavior, not a browser bug). Fixed by
  // giving the wrapper itself a z-index higher than any z-index used
  // elsewhere in the app.
  return createPortal(
    <div className="fixed inset-0" style={{ touchAction: 'manipulation', zIndex: 100 }}>
      {/* Backdrop: dims the rest of the screen, click-to-dismiss. Flat dim
          only — no `backdrop-filter` blur, see the file-header note above. */}
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        style={{
          background: 'rgb(0 0 0 / 0.5)',
          opacity: revealed ? 1 : 0,
          // Forces its own compositing layer — without it, mobile browsers
          // have been seen painting other composited layers (video/voice
          // waveform bubbles, animated message bubbles) *above* this
          // `position: fixed` overlay despite a much higher z-index, since
          // z-index only orders layers reliably when every side of the
          // comparison is actually promoted to one.
          transform: 'translateZ(0)',
          transition: reducedMotion ? 'none' : `opacity ${TRANSITION_MS}ms ease-out`,
        }}
      />

      {/* Lifted bubble clone — display-only, sits above the backdrop but
          never captures pointer events (see bubbleStyle). Tapping "through"
          it dismisses via the backdrop underneath, same as tapping anywhere
          else outside the panel. */}
      <div ref={cloneHostRef} style={bubbleStyle} aria-hidden />

      {/* Action panel. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex flex-col divide-y divide-border overflow-hidden rounded-md bg-surface-raised shadow-strong"
        style={panelStyle}
      >
        {failed ? (
          // docs/RECEIPTS.md §5.4 — a failed send has nothing else to offer:
          // no reactions, no reply target, no body to edit server-side, no
          // send time to show. Discard is the whole menu.
          <button
            onClick={() => onDiscard(message)}
            className="flex items-center gap-3 px-4 py-3 text-left text-sm text-red-600 transition-colors hover:bg-surface-sunken dark:text-red-400"
            style={{ touchAction: 'manipulation' }}
          >
            <Trash2 size={16} />
            Discard
          </button>
        ) : (
          <>
            {/* Quick-emoji row (post-MVP) — always the first row in the panel.
                The trailing `+` is a disabled placeholder for the eventual full
                emoji picker (out of scope here — see the task's Icebox note). */}
            <div className="flex items-center justify-around gap-1 px-2 py-2">
              {ReactionLimits.quickEmojis.map((emoji) => {
                const reacted = message.reactions.some((r) => r.emoji === emoji && r.mine);
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => onReact(message, emoji)}
                    aria-label={`React with ${emoji}`}
                    aria-pressed={reacted}
                    className={
                      'grid h-9 w-9 place-items-center rounded-pill text-lg transition-colors ' +
                      (reacted ? 'bg-accent/15 ring-1 ring-accent' : 'hover:bg-surface-sunken')
                    }
                    style={{ touchAction: 'manipulation' }}
                  >
                    {emoji}
                  </button>
                );
              })}
              <button
                type="button"
                disabled
                title="More reactions (coming soon)"
                aria-label="More reactions (coming soon)"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-pill text-text-muted disabled:opacity-40"
                style={{ touchAction: 'manipulation' }}
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="px-4 py-2.5 text-center text-xs text-text-muted">{formatSendTime(message.createdAt)}</div>
            <button
              onClick={() => onReply(message)}
              className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
              style={{ touchAction: 'manipulation' }}
            >
              <Reply size={16} />
              Reply
            </button>
            {message.body && (
              <button
                onClick={() => onCopy(message)}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
                style={{ touchAction: 'manipulation' }}
              >
                <Copy size={16} />
                Copy
              </button>
            )}
            {/* docs/MESSAGE_EDIT.md — own messages with a body only (text +
                media captions); a message reaching this menu is never a
                soft-deleted one (those are filtered out of every read path and
                removed from the cache on `message.deleted`). No time limit. */}
            {mine && message.body && (
              <button
                onClick={() => onEdit(message)}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
                style={{ touchAction: 'manipulation' }}
              >
                <Pencil size={16} />
                Edit
              </button>
            )}
            {/* docs/GIF_FAVORITES.md §8.1 — sits above Select so the two
                content actions (Reply, Favorite) stay together, ahead of the
                list-management ones. */}
            {onFavorite && (
              <button
                onClick={() => onFavorite(message)}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
                style={{ touchAction: 'manipulation' }}
              >
                <Star size={16} className={favorited ? 'fill-current text-accent' : undefined} />
                {favorited ? 'Remove from favorites' : 'Save to favorites'}
              </button>
            )}
            <button
              onClick={() => onSelect(message)}
              className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
              style={{ touchAction: 'manipulation' }}
            >
              <CheckSquare size={16} />
              Select
            </button>
            {sensitiveMediaIds.length > 0 && (
              <button
                onClick={() => {
                  hide(sensitiveMediaIds);
                  onClose();
                }}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
                style={{ touchAction: 'manipulation' }}
              >
                <EyeOff size={16} />
                Hide again
              </button>
            )}
            {mine && (
              <button
                onClick={() => onDelete(message)}
                className="flex items-center gap-3 px-4 py-3 text-left text-sm text-red-600 transition-colors hover:bg-surface-sunken dark:text-red-400"
                style={{ touchAction: 'manipulation' }}
              >
                <Trash2 size={16} />
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
