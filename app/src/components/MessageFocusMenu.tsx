import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CheckSquare, Copy, Plus, Reply, Trash2 } from 'lucide-react';
import { ReactionLimits, type MeResponse, type Message } from '@den/shared';
import { formatSendTime } from '../lib/datetime';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useBackHandler } from '../lib/backStack';

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
const PANEL_SIDE_BIAS = 0.32; // 0 = dead center, 1 = centered on the bubble; a gentle lean toward the message's side
// Best-effort estimate of the panel's rendered height (quick-emoji row +
// send-time header + Reply + up to 3 more action rows), used only to decide
// whether it should drop *below* or *above* the lifted bubble. Not measured
// against real content sizes or a real device — see the UI-8d notes in
// docs/UI_REVAMP.md §5 for why this is a judgment call, same spirit as
// MediaViewer's VIDEO_CONTROLS_EXCLUSION_HEIGHT. Bumped from 200 when the
// quick-emoji row and Reply row were added (post-MVP reactions/replies).
const PANEL_ESTIMATED_HEIGHT = 300;

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
  onReply,
  onReact,
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
}) {
  const reducedMotion = useReducedMotion();
  // System back gesture / browser back dismisses the menu (matches Escape and
  // the backdrop tap), instead of unwinding the underlying view.
  useBackHandler(true, onClose);
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
    transform: panelRevealed ? 'translateY(0) scale(1)' : `translateY(${panelSide === 'below' ? -6 : 6}px) scale(0.98)`,
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
        {/* Quick-emoji row (post-MVP) — always the first row in the panel.
            The trailing `+` is a disabled placeholder for the eventual full
            emoji picker (out of scope here — see the task's Icebox note). */}
        <div className="flex items-center justify-around gap-1 px-2 py-2">
          {ReactionLimits.quickEmojis.map((emoji) => {
            const mine = message.reactions.some((r) => r.emoji === emoji && r.mine);
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => onReact(message, emoji)}
                aria-label={`React with ${emoji}`}
                aria-pressed={mine}
                className={
                  'grid h-9 w-9 place-items-center rounded-pill text-lg transition-colors ' +
                  (mine ? 'bg-accent/15 ring-1 ring-accent' : 'hover:bg-surface-sunken')
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
