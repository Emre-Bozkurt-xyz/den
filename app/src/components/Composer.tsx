import { useEffect, useRef, useState } from 'react';
import { Mic, Paperclip, Send, Square, X } from 'lucide-react';
import { RecordingBar, type RecState } from './RecordingBar';

/**
 * UI-8e (docs/archive/UI8_CHAT_INSTAGRAM.md) — the chat composer, extracted out of
 * `ChatView` (which was pushing 900 lines) so the recording state machine
 * has somewhere to live that isn't the message-list component. Owns: text
 * input + attach + mic/send, and the full hold-to-record / slide-up-to-lock
 * / slide-left-to-cancel gesture + live-waveform recording bar. `ChatView`
 * still owns the *draft text* (per-chat cache, see its own doc comment) and
 * the *upload* orchestration (`runUpload`, `handleFilePicked`) — this
 * component is handed `draft`/`onDraftChange` as a controlled input and
 * calls back out via `onSend`/`onPickFiles`/`onRecordingComplete` rather
 * than reimplementing any of that.
 *
 * ⚠️ iOS: `getUserMedia` and `AudioContext` both need a user gesture.
 * `onMicPointerDown`/`onMicClick` create+resume the `AudioContext`
 * *synchronously*, before the `getUserMedia` await, and call
 * `getUserMedia` itself synchronously as the first statement of
 * `beginRecording` — never behind an earlier await that would lose the
 * gesture association. See the per-handler comments below.
 */

// Gesture thresholds — convention-based defaults, grouped here for later
// real-device tuning (Samsung/iPhone pass), same posture as UI-6's
// MediaViewer thresholds (docs/archive/UI_REVAMP.md §8).
const LOCK_THRESHOLD_DY = -115; // px — slide up past this to lock (hands-free); raised from -80, which armed too early (user feedback)
const CANCEL_THRESHOLD_DX = -120; // px — slide left past this to cancel

const LEVEL_BAR_COUNT = 32; // rolling window length for the live waveform
const LEVEL_SAMPLE_INTERVAL_MS = 80; // how often a rAF-driven sample commits into the rolling window (~12/s — smooth enough, cheap enough)
const LEVEL_GAIN = 4; // rough visual boost so quiet mic input still reads as a real waveform, not a flat line — untuned, see file header

// Auto-growing textarea (user feedback, 2026-07-22 — the old single-line
// <input> overflowed longer messages). Grows with content up to a clamp, then
// scrolls internally, the way every mature messenger composer does.
const COMPOSER_MAX_HEIGHT = 128; // px — ~5-6 lines before it starts scrolling

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Best-effort haptic tick for gesture threshold crossings (user feedback,
 *  2026-07-22). Android Chrome supports the Vibration API; iOS Safari does
 *  not expose it at all, so this is a silent no-op there — feature-detected,
 *  never assumed. */
function haptic(ms: number): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
}

function rmsLevel(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i]! - 128) / 128; // center at 0, range -1..1
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

export function Composer({
  draft,
  onDraftChange,
  onSend,
  onPickFiles,
  uploading,
  onRecordingComplete,
  onError,
  isMobile,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onPickFiles: (files: File[]) => void;
  /** Disables attach/mic while a media upload is already in flight — same
   *  guard the pre-UI-8e composer applied. */
  uploading: boolean;
  /** Hands a finished recording off to `ChatView`'s existing `runUpload`
   *  path — this component never talks to the media API directly. */
  onRecordingComplete: (blob: Blob, mime: string) => void;
  /** Generalized from `onRecordingError` (docs/IMAGE_PASTE.md) once paste
   *  needed the same "surface a message, don't touch upload state" callback
   *  the mic already had — it's still just `setUploadError` in `ChatView`. */
  onError: (message: string) => void;
  isMobile: boolean;
}) {
  const [recState, setRecState] = useState<RecState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(LEVEL_BAR_COUNT).fill(0.05) as number[]);
  // Live drag feedback (mobile only) — 0 at rest, negative as the finger
  // moves up/left; only meaningful while recState is 'requesting'/'recording'
  // (i.e. before lock).
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tracks whether the in-progress cancel drag has crossed the threshold, so
  // the haptic tick fires exactly once on crossing (not every pointermove).
  const cancelArmedRef = useRef(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Set just before calling recorder.stop() for a cancel (as opposed to a
  // finish) so the `onstop` handler knows to discard instead of upload.
  const discardRef = useRef(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Explicit `<ArrayBuffer>` generic (not just `Uint8Array`): TS 5.7+'s DOM
  // lib narrowed `AnalyserNode.getByteTimeDomainData`'s parameter to
  // `Uint8Array<ArrayBuffer>` specifically, and an unparameterized
  // `Uint8Array | null` ref type infers the wider `ArrayBufferLike`.
  const timeDomainBufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const levelRafRef = useRef<number | null>(null);

  const startTimeRef = useRef(0);
  const elapsedTimerRef = useRef<number | null>(null);

  // Raw pointer-gesture bookkeeping for the mic button — same shape/spirit
  // as MediaViewer's gestureRef (docs/archive/UI_REVAMP.md UI-6): a plain ref, not
  // state, since it's read/written on every pointermove and doesn't itself
  // need to trigger a render (dragX/dragY, which do, are derived from it).
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);

  // Full teardown on unmount (e.g. the user navigates to a different chat
  // mid-recording) — discards rather than uploads a stray voice message,
  // and releases the mic/AudioContext either way.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      stopLevelLoop();
      stopElapsedTimer();
      closeAudioContext();
    };
    // Intentionally mount/unmount-only — the cleanup reads refs, not state,
    // so there's nothing to add to this dependency list.
  }, []);

  // Re-measure whenever the text changes — including external clears (send
  // empties the parent-owned `draft`, which snaps the box back to one line).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  function submit() {
    if (!draft.trim()) return;
    onSend();
    // Keep focus in the field so the on-screen keyboard doesn't collapse
    // after every send (user feedback: Samsung PWA dropped the keyboard and
    // forced a re-tap). The send button itself also suppresses its own
    // focus-steal via onPointerDown (see the JSX) — this refocus covers the
    // Enter-to-send path and is a harmless no-op when focus never left.
    textareaRef.current?.focus();
  }

  function stopLevelLoop() {
    if (levelRafRef.current !== null) cancelAnimationFrame(levelRafRef.current);
    levelRafRef.current = null;
    analyserRef.current = null;
    timeDomainBufRef.current = null;
  }

  function stopElapsedTimer() {
    if (elapsedTimerRef.current !== null) window.clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = null;
  }

  function closeAudioContext() {
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== 'closed') void ctx.close();
  }

  /** Must be called synchronously inside the pointerdown/click handler,
   *  before `beginRecording`'s `getUserMedia` await — iOS ties both the mic
   *  prompt *and* `AudioContext` construction/resume to the original user
   *  gesture; deferring either behind an earlier await loses that
   *  association and Safari silently refuses to start. The stream itself
   *  isn't connected to the analyser until it actually arrives (see
   *  `connectLevelMeter`), but the context is created/resumed right here. */
  function primeAudioContext() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webkit-prefixed fallback isn't in lib.dom, same pattern as lib/waveform.ts
    const Ctor: any = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    const ctx: AudioContext = new Ctor();
    audioCtxRef.current = ctx;
    void ctx.resume();
  }

  function connectLevelMeter(stream: MediaStream) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;
    timeDomainBufRef.current = new Uint8Array(analyser.fftSize);
    startLevelLoop();
  }

  function startLevelLoop() {
    let lastSample = 0;
    const tick = () => {
      const analyser = analyserRef.current;
      const buf = timeDomainBufRef.current;
      if (analyser && buf) {
        const now = performance.now();
        if (now - lastSample >= LEVEL_SAMPLE_INTERVAL_MS) {
          lastSample = now;
          analyser.getByteTimeDomainData(buf);
          const level = clamp01(rmsLevel(buf) * LEVEL_GAIN);
          setLevels((prev) => [...prev.slice(1), level]);
        }
      }
      levelRafRef.current = requestAnimationFrame(tick);
    };
    levelRafRef.current = requestAnimationFrame(tick);
  }

  function startElapsedTimer() {
    startTimeRef.current = Date.now();
    elapsedTimerRef.current = window.setInterval(() => setElapsedMs(Date.now() - startTimeRef.current), 100);
  }

  async function beginRecording() {
    setRecState('requesting');
    setElapsedMs(0);
    setLevels(Array(LEVEL_BAR_COUNT).fill(0.05) as number[]);
    try {
      // Synchronous as the first statement of this async function's body —
      // still tied to the originating gesture even though the function
      // itself is `async` (the call happens before any `await` runs).
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      connectLevelMeter(stream);
      const rec = new MediaRecorder(stream); // platform picks its native container; server normalizes to m4a — same as the pre-UI-8e implementation, not rewritten
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const discarded = discardRef.current;
        discardRef.current = false;
        if (!discarded && chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
          onRecordingComplete(blob, blob.type);
        }
        chunksRef.current = [];
      };
      recorderRef.current = rec;
      rec.start();
      startElapsedTimer();
      setRecState('recording');
    } catch {
      closeAudioContext();
      setRecState('idle');
      onError('Microphone access failed');
    }
  }

  function finishRecording() {
    recorderRef.current?.stop(); // → onstop → onRecordingComplete
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    stopLevelLoop();
    stopElapsedTimer();
    closeAudioContext();
    setRecState('idle');
  }

  function cancelRecording() {
    discardRef.current = true;
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    stopLevelLoop();
    stopElapsedTimer();
    closeAudioContext();
    setRecState('cancelling');
    // Brief discard flash before returning to the plain composer — purely
    // cosmetic, matches the ~150-200ms register of every other UI-8 transition.
    window.setTimeout(() => setRecState('idle'), 200);
  }

  function lockRecording() {
    setRecState('locked');
    gestureRef.current = null;
    setDragX(0);
    setDragY(0);
  }

  // --- Mobile gesture handlers, all on the same persistent mic/trigger
  // button (see the JSX below for why it must stay the same element across
  // idle→requesting→recording→[lock]). ---

  function onMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!isMobile || e.pointerType === 'mouse') return; // desktop uses onMicClick
    e.currentTarget.setPointerCapture(e.pointerId);
    gestureRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    cancelArmedRef.current = false;
    setDragX(0);
    setDragY(0);
    primeAudioContext();
    void beginRecording();
  }

  function onMicPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId || recState !== 'recording') return;
    const dx = Math.min(0, e.clientX - g.startX);
    const dy = Math.min(0, e.clientY - g.startY);
    setDragX(dx);
    setDragY(dy);

    // Fire a single haptic tick the moment the cancel drag arms/disarms, so
    // the user feels the threshold rather than only seeing it (the visual
    // arm state lives in RecordingBar, keyed off cancelProgress ≥ 1).
    const cancelArmed = dx <= CANCEL_THRESHOLD_DX;
    if (cancelArmed !== cancelArmedRef.current) {
      cancelArmedRef.current = cancelArmed;
      if (cancelArmed) haptic(40);
    }

    // Crossing the lock threshold both locks *and* ticks — this only ever
    // fires once because locking flips recState out of 'recording', after
    // which this handler early-returns.
    if (dy <= LOCK_THRESHOLD_DY) {
      haptic(30);
      lockRecording();
    }
  }

  function onMicPointerUp(e: React.PointerEvent<HTMLButtonElement>) {
    const g = gestureRef.current;
    gestureRef.current = null;
    cancelArmedRef.current = false;
    if (!g || g.pointerId !== e.pointerId) return;
    if (recState === 'locked') return; // already hands-free; the Stop/Cancel buttons take it from here
    if (recState !== 'recording' && recState !== 'requesting') return;
    const dx = e.clientX - g.startX;
    setDragX(0);
    setDragY(0);
    if (dx <= CANCEL_THRESHOLD_DX) cancelRecording();
    else finishRecording(); // release = send (push-to-talk)
  }

  function onMicPointerCancel() {
    // Browser-interrupted gesture (e.g. an edge-swipe took over) — same
    // "abort safely" posture as MediaViewer's pointercancel handlers.
    gestureRef.current = null;
    cancelArmedRef.current = false;
    setDragX(0);
    setDragY(0);
    if (recState === 'recording' || recState === 'requesting') cancelRecording();
  }

  function onMicClick() {
    if (isMobile) return; // mobile is pointer-gesture driven, handled above
    if (recState === 'idle') {
      primeAudioContext();
      void beginRecording();
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // allow picking the same file(s) again
    onPickFiles(files);
  }

  /** docs/IMAGE_PASTE.md — desktop Ctrl+V of a screenshot, or mobile
   *  long-press → Paste, land here as a `ClipboardEvent` with `.files`
   *  populated. No files → leave the event alone entirely (no
   *  `preventDefault()`) so plain text paste behaves exactly as before.
   *  Files present → this *is* the paste, even on a mixed clipboard (e.g.
   *  copied off a web page, file + filename text): we take the file and
   *  drop the text, matching Discord/Slack. Routes into the same
   *  `onPickFiles` the attach button uses — `ChatView.handleFilesPicked`
   *  already filters kinds and reports skips, so no filtering here.
   *  ⚠️ iOS Safari / Android Samsung Keyboard clipboard-image paste is
   *  unverified on real hardware — see PROJECT.md §12. */
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    if (uploading) {
      onError('Upload in progress');
      return;
    }
    onPickFiles(Array.from(files));
  }

  const lockProgress = clamp01(dragY / LOCK_THRESHOLD_DY);
  const cancelProgress = clamp01(dragX / CANCEL_THRESHOLD_DX);
  // Desktop shows explicit Stop/Cancel buttons for the whole recording
  // lifecycle (no gesture to protect); mobile only swaps to them once
  // locked, since the drag gesture up to that point lives entirely on the
  // mic button itself (see the trailing-slot JSX below).
  const showExplicitStopCancel = recState === 'locked' || (!isMobile && recState !== 'idle');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-border bg-surface-raised p-3"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
    >
      <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden onChange={handleFileInputChange} />

      {/* Leading slot: attach button while idle, an explicit Cancel button
          once recording has a Stop/Cancel pair (see showExplicitStopCancel). */}
      {recState === 'idle' ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Attach photo or video"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-border text-text-secondary transition-colors hover:bg-surface-sunken active:bg-surface-sunken disabled:opacity-40"
          style={{ touchAction: 'manipulation' }}
        >
          <Paperclip size={18} />
        </button>
      ) : showExplicitStopCancel ? (
        <button
          type="button"
          onClick={cancelRecording}
          aria-label="Cancel recording"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-border text-text-secondary transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
          style={{ touchAction: 'manipulation' }}
        >
          <X size={18} />
        </button>
      ) : null}

      {/* Middle slot: text input while idle, the live recording bar
          otherwise. Cross-fades in via .animate-composer-morph on mount —
          see index.css. */}
      {recState === 'idle' ? (
        <textarea
          ref={textareaRef}
          key="text"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Desktop: Enter sends, Shift+Enter inserts a newline. Mobile:
            // Enter always inserts a newline (there's a dedicated send
            // button, and a soft-keyboard return key sending would be a
            // surprise) — matches Instagram/WhatsApp.
            if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder="Message"
          className="max-h-32 min-h-[44px] min-w-0 flex-1 resize-none animate-composer-morph overflow-y-auto rounded-[22px] border border-border bg-surface px-4 py-2.5 text-base leading-6 text-text-primary outline-none transition-colors focus:border-accent"
        />
      ) : (
        <div key="bar" className="animate-composer-morph flex min-w-0 flex-1">
          <RecordingBar
            recState={recState}
            elapsedMs={elapsedMs}
            levels={levels}
            isMobile={isMobile}
            lockProgress={recState === 'recording' ? lockProgress : 0}
            cancelProgress={recState === 'recording' ? cancelProgress : 0}
          />
        </div>
      )}

      {/* Trailing slot — deliberately the *same* JSX branch (this exact
          MicTriggerButton) across idle→requesting→recording on mobile, so
          the pointer-captured element backing the hold/slide gestures is
          never unmounted mid-touch. It only swaps to the Stop/Send button
          once locked (drag already fully resolved by then) or on desktop
          (no drag to protect in the first place). */}
      {showExplicitStopCancel ? (
        <button
          type="button"
          onClick={finishRecording}
          aria-label="Stop and send recording"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-accent text-white transition-colors hover:bg-accent-hover active:bg-accent-hover"
          style={{ touchAction: 'manipulation' }}
        >
          <Square size={16} fill="currentColor" />
        </button>
      ) : recState === 'idle' && draft.trim() ? (
        <button
          type="submit"
          // Suppress the button's own focus-steal so tapping Send doesn't blur
          // the textarea and collapse the on-screen keyboard (user feedback:
          // Samsung PWA). The click/submit still fires normally; only the
          // default focus shift is cancelled.
          onPointerDown={(e) => e.preventDefault()}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-pill bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:bg-accent-hover"
          style={{ touchAction: 'manipulation' }}
        >
          <Send size={15} />
          Send
        </button>
      ) : (
        <button
          type="button"
          onPointerDown={onMicPointerDown}
          onPointerMove={onMicPointerMove}
          onPointerUp={onMicPointerUp}
          onPointerCancel={onMicPointerCancel}
          onClick={onMicClick}
          disabled={uploading && recState === 'idle'}
          aria-label={recState === 'idle' ? 'Record voice message — press and hold' : 'Recording — release to send'}
          className={
            'grid h-11 w-11 shrink-0 place-items-center rounded-pill text-white transition-colors disabled:opacity-40 ' +
            (recState === 'idle' ? 'bg-accent hover:bg-accent-hover active:bg-accent-hover' : 'bg-rose-600')
          }
          style={{ touchAction: 'none' }}
        >
          <Mic size={18} />
        </button>
      )}
    </form>
  );
}
