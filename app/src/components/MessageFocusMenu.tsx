import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CheckSquare, Copy, Trash2 } from 'lucide-react';
import type { MeResponse, Message } from '@den/shared';
import { formatSendTime } from '../lib/datetime';
import { useReducedMotion } from '../hooks/useReducedMotion';

/**
 * iMessage-style "focus" action menu (UI-8d request F,
 * docs/UI8_CHAT_INSTAGRAM.md) — replaces the old bottom-sheet action menu.
 * The tapped/clicked bubble visually lifts in place, the rest of the screen
 * dims + blurs behind it, and an action panel drops in just below (or above,
 * near the bottom of the viewport) it. Opens from the three-dots (desktop,
 * UI-8c) or long-press (mobile, unchanged from before this stage).
 *
 * **Hand-rolled, no animation library.** The "lift" is a `cloneNode(true)`
 * of the *real* bubble DOM node (captured via `ChatView`'s `messageRefs`),
 * mounted into a `position: fixed` host at the exact `DOMRect` it was
 * captured at, then eased to a slightly-scaled resting transform — a classic
 * shared-element trick without needing to re-implement bubble/media/voice
 * rendering a second time here. The clone is decorative only
 * (`pointer-events: none`, interactive descendants disabled) — it is never a
 * second live control surface.
 */

const LIFT_SCALE = 1.03;
const TRANSITION_MS = 150;
const PANEL_STAGGER_MS = 60; // panel starts easing in slightly after the bubble begins lifting — a small stagger, not a strict "wait for the bubble to finish"
const VIEWPORT_MARGIN = 16; // px — keeps the panel off the screen edges; "clean margins", never edge-to-edge
// Best-effort estimate of the panel's rendered height (send-time header +
// up to 3 action rows), used only to decide whether it should drop *below*
// or *above* the lifted bubble. Not measured against real content sizes or a
// real device — see the UI-8d notes in docs/UI_REVAMP.md §5 for why this is
// a judgment call, same spirit as MediaViewer's VIDEO_CONTROLS_EXCLUSION_HEIGHT.
const PANEL_ESTIMATED_HEIGHT = 200;

// Feature-detected once at module load — support doesn't change at runtime.
// iOS Safari 16.4+ (our floor) has `backdrop-filter`, but it's flagged for a
// real-device perf/quirk check per the stage's iOS notes; the no-support path
// (older/other browsers) falls back to a heavier flat dim, no blur.
const BACKDROP_FILTER_SUPPORTED =
  typeof CSS !== 'undefined' && (CSS.supports('backdrop-filter', 'blur(4px)') || CSS.supports('-webkit-backdrop-filter', 'blur(4px)'));

export function MessageFocusMenu({
  message,
  rect,
  sourceEl,
  me,
  onClose,
  onCopy,
  onSelect,
  onDelete,
}: {
  message: Message;
  /** Captured via `messageRefs.get(id).getBoundingClientRect()` at the
   *  moment the menu opens (`ChatView`'s `openActionMenu`) — the on-screen
   *  position the lift animates *from*. */
  rect: DOMRect;
  /** The real bubble DOM node the lifted clone is copied from. */
  sourceEl: HTMLElement;
  me: MeResponse;
  onClose: () => void;
  onCopy: (m: Message) => void;
  onSelect: (m: Message) => void;
  onDelete: (m: Message) => void;
}) {
  const reducedMotion = useReducedMotion();
  const [revealed, setRevealed] = useState(reducedMotion);
  const [panelRevealed, setPanelRevealed] = useState(reducedMotion);
  const cloneHostRef = useRef<HTMLDivElement>(null);
  const mine = message.senderId === me.id;

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
    transform: revealed ? `scale(${LIFT_SCALE})` : 'scale(1)',
    transition: reducedMotion ? 'none' : `transform ${TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1)`,
    zIndex: 61,
    pointerEvents: 'none',
  };

  const panelStyle: CSSProperties = {
    position: 'fixed',
    left: '50%',
    ...(panelSide === 'below' ? { top: rect.bottom + 8 } : { bottom: viewportH - rect.top + 8 }),
    width: 'min(85vw, 320px)',
    maxHeight: `calc(100vh - ${VIEWPORT_MARGIN * 2}px)`,
    opacity: panelRevealed ? 1 : 0,
    transform: `translateX(-50%) ${panelRevealed ? 'translateY(0) scale(1)' : `translateY(${panelSide === 'below' ? -6 : 6}px) scale(0.98)`}`,
    transition: reducedMotion ? 'none' : `opacity ${TRANSITION_MS}ms ease-out, transform ${TRANSITION_MS}ms cubic-bezier(0.22,1,0.36,1)`,
    zIndex: 62,
    paddingBottom: 'env(safe-area-inset-bottom)',
  };

  return (
    <div className="fixed inset-0" style={{ touchAction: 'manipulation' }}>
      {/* Backdrop: dims + blurs the rest of the screen, click-to-dismiss.
          Falls back to a heavier flat dim (no blur) when backdrop-filter
          isn't supported — see BACKDROP_FILTER_SUPPORTED above. */}
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        style={{
          background: BACKDROP_FILTER_SUPPORTED ? 'rgb(0 0 0 / 0.3)' : 'rgb(0 0 0 / 0.5)',
          backdropFilter: BACKDROP_FILTER_SUPPORTED ? 'blur(4px)' : undefined,
          WebkitBackdropFilter: BACKDROP_FILTER_SUPPORTED ? 'blur(4px)' : undefined,
          opacity: revealed ? 1 : 0,
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
        <div className="px-4 py-2.5 text-center text-xs text-text-muted">{formatSendTime(message.createdAt)}</div>
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
        <button
          onClick={() => onSelect(message)}
          className="flex items-center gap-3 px-4 py-3 text-left text-sm text-text-primary transition-colors hover:bg-surface-sunken"
          style={{ touchAction: 'manipulation' }}
        >
          <CheckSquare size={16} />
          Select
        </button>
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
      </div>
    </div>
  );
}
