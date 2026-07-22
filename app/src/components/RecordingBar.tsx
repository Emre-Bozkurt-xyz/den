import { ChevronUp, Lock, Square } from 'lucide-react';

/**
 * UI-8e recording state machine (docs/UI8_CHAT_INSTAGRAM.md) — owned by
 * `Composer`, rendered here only as a type so `RecordingBar` (purely
 * presentational, see below) and `Composer` (the state owner) share one
 * definition.
 *  - `idle → requesting` on mic press (`getUserMedia` in flight).
 *  - `requesting → recording` on stream grant, or back to `idle` + an error
 *    surfaced via `onRecordingError` on deny.
 *  - `recording → idle` (send) on release (unlocked, push-to-talk) or the
 *    desktop Stop button; `recording → locked` on slide-up-past-threshold;
 *    `recording → cancelling → idle` (discard) on slide-left-past-threshold
 *    or the desktop Cancel button.
 *  - `locked → idle` (send) on the post-lock Stop button; `locked →
 *    cancelling → idle` (discard) on the post-lock Cancel button. Once
 *    locked, lifting the recording finger does *nothing* by itself — only
 *    those two explicit buttons resolve it.
 */
export type RecState = 'idle' | 'requesting' | 'recording' | 'locked' | 'cancelling';

const BAR_MIN_SCALE = 0.08; // a hairline floor, never a true gap — mirrors VoiceMessage's BAR_MIN_SCALE

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
}

/**
 * The live-waveform recording bar's middle content — timer, scrolling
 * levels, and (mobile, unlocked only) the passive lock-chevron and
 * slide-to-cancel hint that follow the ongoing drag. Purely presentational:
 * every number it draws is computed by `Composer`, which owns the actual
 * `MediaRecorder`/`AnalyserNode`/gesture-tracking state. This split mirrors
 * `VoiceMessage` (decoded peaks) vs. its player chrome, except these levels
 * are *live* (`AnalyserNode.getByteTimeDomainData`, sampled in a rAF loop),
 * not decoded from a finished file — see `Composer`'s recording internals.
 */
export function RecordingBar({
  recState,
  elapsedMs,
  levels,
  isMobile,
  lockProgress,
  cancelProgress,
}: {
  recState: RecState;
  elapsedMs: number;
  levels: number[];
  isMobile: boolean;
  /** 0..1 — how close an in-progress mobile drag is to the slide-up-to-lock
   *  threshold. Always 0 once locked or on desktop (no live drag to show). */
  lockProgress: number;
  /** 0..1 — how close an in-progress mobile drag is to the slide-left-to-
   *  cancel threshold. Always 0 once locked or on desktop. */
  cancelProgress: number;
}) {
  const showDragHints = isMobile && (recState === 'recording' || recState === 'requesting');
  const cancelling = recState === 'cancelling';
  // "Armed" = the finger has crossed the threshold and *releasing now* will
  // act. Composer clamps each progress to exactly 1 at its threshold, so ≥1
  // is the arm signal (user feedback, 2026-07-22 — wanted a clear "this will
  // cancel" state, not just a sliding hint).
  const cancelArmed = cancelProgress >= 1;
  const lockArmed = lockProgress >= 1;

  return (
    <div
      className={
        'flex h-11 min-w-0 flex-1 items-center gap-2 rounded-pill border bg-surface px-3 transition-[opacity,border-color] ' +
        (cancelling ? 'opacity-50 ' : 'opacity-100 ') +
        // The whole bar tints red the moment cancel arms, reinforcing the
        // growing stop icon so it's unmissable that a release cancels.
        (cancelArmed ? 'border-red-500' : 'border-border')
      }
    >
      {/* Slide-to-cancel affordance — a passive indicator, not a real button
          (the actual cancel trigger is Composer's drag-distance check on the
          mic button). The classic stop square grows and reddens as the drag
          approaches the threshold, then snaps to a solid, pulsing red once
          armed — a responsiveness cue that follows the finger. */}
      {showDragHints && (
        <span
          className={
            'flex shrink-0 items-center transition-colors ' +
            (cancelArmed ? 'animate-pulse text-red-500' : cancelProgress > 0.5 ? 'text-red-400' : 'text-text-muted')
          }
          style={{ transform: `scale(${1 + cancelProgress * 0.6})`, transformOrigin: 'center' }}
          aria-hidden
        >
          <Square size={14} fill={cancelArmed ? 'currentColor' : 'none'} strokeWidth={2.25} />
        </span>
      )}

      {/* Rec dot + timer. Dims while a cancel is armed so attention moves to
          the stop icon. */}
      <span
        className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-text-secondary transition-opacity"
        style={{ opacity: cancelArmed ? 0.4 : 1 }}
      >
        <span className={'h-2 w-2 rounded-pill bg-red-500 ' + (recState === 'recording' || recState === 'locked' ? 'animate-pulse' : 'opacity-40')} />
        {recState === 'requesting' ? '...' : formatElapsed(elapsedMs)}
      </span>

      {/* Live waveform. */}
      <div className="flex h-6 min-w-0 flex-1 items-center gap-[2px]" style={{ opacity: cancelArmed ? 0.4 : 1 }}>
        {levels.map((v, i) => (
          <span
            key={i}
            className="min-w-[2px] flex-1 rounded-pill bg-current text-text-secondary"
            style={{ height: `${Math.max(BAR_MIN_SCALE, v) * 100}%`, opacity: 0.6 }}
          />
        ))}
      </div>

      {/* Lock affordance — an up-chevron above a lock, in a soft pill so it
          reads as a control rather than a stray glyph (user feedback: the old
          14px muted lock was too easy to miss). As the drag rises it travels
          *upward* (translateY tracks the finger), grows, and shifts to the
          accent, snapping to a solid accent lock once armed/locked. Origin is
          the bottom so the growth pushes it up toward where the finger is
          headed. `overflow-visible` on the bar (default) lets it rise above
          the composer edge, WhatsApp-style. */}
      {isMobile && (recState === 'locked' || showDragHints) && (
        <span
          className={
            'flex shrink-0 flex-col items-center gap-0.5 rounded-pill px-1.5 py-1 transition-colors ' +
            (recState === 'locked' || lockArmed ? 'bg-accent/15 text-accent' : 'bg-current/10 text-text-secondary')
          }
          style={{
            opacity: recState === 'locked' ? 1 : 0.6 + lockProgress * 0.4,
            transform: `translateY(${recState === 'locked' ? 0 : -lockProgress * 22}px) scale(${recState === 'locked' ? 1 : 1 + lockProgress * 0.55})`,
            transformOrigin: 'bottom center',
          }}
          aria-hidden
        >
          {recState !== 'locked' && (
            <ChevronUp size={12} className="animate-pulse" style={{ opacity: 0.4 + lockProgress * 0.6 }} />
          )}
          <Lock size={18} fill={recState === 'locked' || lockArmed ? 'currentColor' : 'none'} />
        </span>
      )}
    </div>
  );
}
