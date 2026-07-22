import { Lock } from 'lucide-react';

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

  return (
    <div
      className={
        'flex h-11 min-w-0 flex-1 items-center gap-2 rounded-pill border border-border bg-surface px-3 transition-opacity ' +
        (cancelling ? 'opacity-50' : 'opacity-100')
      }
    >
      {/* Slide-to-cancel hint — a passive target, not a real button; the
          actual cancel trigger is Composer's drag-distance check on the mic
          button itself. Fades toward the cancel threshold as feedback that
          follows the finger, per the UI-8e gesture spec. */}
      {showDragHints && (
        <span
          className="flex shrink-0 items-center gap-1 text-xs text-text-muted"
          style={{ opacity: 1 - cancelProgress * 0.85, transform: `translateX(${-cancelProgress * 6}px)` }}
        >
          ‹ Slide to cancel
        </span>
      )}

      {/* Rec dot + timer. */}
      <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-text-secondary">
        <span className={'h-2 w-2 rounded-pill bg-red-500 ' + (recState === 'recording' || recState === 'locked' ? 'animate-pulse' : 'opacity-40')} />
        {recState === 'requesting' ? '...' : formatElapsed(elapsedMs)}
      </span>

      {/* Live waveform. */}
      <div className="flex h-6 min-w-0 flex-1 items-center gap-[2px]">
        {levels.map((v, i) => (
          <span
            key={i}
            className="min-w-[2px] flex-1 rounded-pill bg-current text-text-secondary"
            style={{ height: `${Math.max(BAR_MIN_SCALE, v) * 100}%`, opacity: 0.6 }}
          />
        ))}
      </div>

      {/* Lock chevron — fills in as a mobile drag approaches the lock
          threshold; a static (unfilled) lock icon once actually locked. */}
      {isMobile && (recState === 'locked' || showDragHints) && (
        <span
          className="flex shrink-0 items-center text-text-muted"
          style={{ opacity: recState === 'locked' ? 1 : 0.35 + lockProgress * 0.65 }}
        >
          <Lock size={14} fill={recState === 'locked' || lockProgress > 0.99 ? 'currentColor' : 'none'} />
        </span>
      )}
    </div>
  );
}
