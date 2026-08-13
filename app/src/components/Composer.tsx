import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, EyeOff, FileQuestion, Mic, Paperclip, Play, Plus, Send, Square, X } from 'lucide-react';
import { detectEmbedUrl, sensitivityOf, type EmbedProvider } from '@den/shared';
import { useKeyboardInset } from '../hooks/useKeyboardInset';
import type { StagedAttachment } from '../lib/media';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { RecordingBar, type RecState } from './RecordingBar';
import { SensitiveOverlay } from './SensitiveOverlay';

// docs/EMBEDS.md §4.4 — the composer's paste/type-detect chip: "picking is
// sending" precedent, so this is purely informational (send behaves exactly
// the same either way; the server does its own detection independently,
// shared/src/embeds.ts) — never a pre-send preview/confirm step.
const EMBED_CHIP_LABEL: Record<EmbedProvider, string> = {
  instagram: '🎬 Instagram reel — sends as a card',
  vault: '📄 Vault doc — sends as a card',
};

/**
 * UI-8e (docs/archive/UI8_CHAT_INSTAGRAM.md) — the chat composer, extracted out of
 * `ChatView` (which was pushing 900 lines) so the recording state machine
 * has somewhere to live that isn't the message-list component. Owns: text
 * input + attach + mic/send, and the full hold-to-record / slide-up-to-lock
 * / slide-left-to-cancel gesture + live-waveform recording bar. `ChatView`
 * still owns the *draft text* (per-chat cache, see its own doc comment), the
 * *staged attachments* array, and the album/voice upload orchestration
 * (`sendAlbum`/`handleRecordingComplete`, docs/MEDIA_ATTACHMENTS.md §5.1) —
 * this component is handed `draft`/`onDraftChange`/`attachments` as
 * controlled props and calls back out via `onSend`/`onAddFiles`/
 * `onRecordingComplete` rather than reimplementing any of that. It DOES own
 * the tray's own rendering, attach/paste validation staging, and per-thumb
 * object-URL lifecycle (see the tray effects below).
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
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onOpenAttachment,
  onInputFocus,
  uploading,
  onRecordingComplete,
  onError,
  isMobile,
  editing,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  /** docs/MEDIA_ATTACHMENTS.md §5.1 — staged, not-yet-uploaded picks. Lives
   *  in `ChatView` state; this component only renders the tray and mutates
   *  it through the callbacks below. */
  attachments: StagedAttachment[];
  /** Attach button / file input / paste all funnel here. Validation
   *  (`stageFiles` — kind, size, `MediaLimits.maxAttachments`) happens once,
   *  centrally, in `ChatView`, which also owns surfacing the result through
   *  `onError`. */
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  /** A tray thumbnail was tapped — opens `ChatView`'s `AttachmentSheet`. */
  onOpenAttachment: (localId: string) => void;
  /** The text field took focus, i.e. the soft keyboard is coming up —
   *  `ChatView` re-pins the message list to the bottom (see its
   *  `handleComposerFocus`). The scroll behavior stays over there with the
   *  rest of the scroller logic; this component only reports the event. */
  onInputFocus: () => void;
  /** Disables attach/mic while an album send is already in flight — same
   *  guard the pre-album composer applied to the old per-file upload. */
  uploading: boolean;
  /** Hands a finished recording off to `ChatView`'s existing upload path —
   *  this component never talks to the media API directly. Voice is
   *  unchanged by staging (docs §5.1): push-to-talk still sends immediately. */
  onRecordingComplete: (blob: Blob, mime: string) => void;
  /** Generalized from `onRecordingError` (docs/IMAGE_PASTE.md) once paste
   *  needed the same "surface a message, don't touch upload state" callback
   *  the mic already had — it's still just `setUploadError` in `ChatView`. */
  onError: (message: string) => void;
  isMobile: boolean;
  /** docs/MESSAGE_EDIT.md §4.3 — `ChatView` is editing a message: attach and
   *  mic are hidden (only the submit control remains, restyled Update), and
   *  `onSend` submits the edit instead of a new message. Recording/gesture
   *  code paths are unreachable in this mode simply because the mic button
   *  isn't rendered — no mode checks needed inside those handlers.
   *  docs/MEDIA_ATTACHMENTS.md §5.1: `ChatView` blocks entering edit mode
   *  while attachments are staged, so `attachments` is always `[]` here
   *  whenever `editing` is true. */
  editing: boolean;
}) {
  // docs/IOS_KEYBOARD.md — 0 on Android/desktop (the hook's iOS gate is off),
  // so `keyboardInset > 0` below never trips there and this component's
  // styling is unaffected.
  const keyboardInset = useKeyboardInset();
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

  // docs/MEDIA_ATTACHMENTS.md §5.1 — revokes an attachment's `previewUrl`
  // (created by `handleFileInputChange`/`handlePaste` below) the moment it
  // stops being staged, however that happens: the tray's own ✕, a
  // successful send clearing `ChatView`'s attachments array, or this
  // component unmounting outright (chat switch) mid-stage. Diffing against
  // the previous render's array (rather than only revoking in the ✕
  // handler) covers all three with one effect instead of three call sites
  // that could drift out of sync — "leaking object URLs is a real bug here"
  // per the task brief.
  const prevAttachmentsRef = useRef<StagedAttachment[]>([]);
  useEffect(() => {
    const nextIds = new Set(attachments.map((a) => a.localId));
    for (const a of prevAttachmentsRef.current) {
      if (!nextIds.has(a.localId) && a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    prevAttachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    return () => {
      for (const a of prevAttachmentsRef.current) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    };
  }, []);

  // docs/MESSAGE_EDIT.md §4.2 "focus the composer" on entering edit mode.
  // The textarea element itself never unmounts across the `editing` toggle
  // (only the leading/trailing slots change), so a plain focus() call here
  // is enough — no ref-forwarding needed from `ChatView`.
  // ⚠️ iOS: this fires from a `useEffect` after the triggering tap (the focus
  // menu's Edit row) has already returned control to the browser, not
  // synchronously inside that click handler — Safari's "must be a direct
  // result of a user gesture" rule for raising the on-screen keyboard may not
  // consider this close enough. Unverified on real iOS hardware; if the
  // keyboard doesn't appear, the draft is still focused/editable once tapped
  // manually, so this degrades to one extra tap rather than breaking the flow.
  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  function submit() {
    // docs/MEDIA_ATTACHMENTS.md §5.1 — Send appears (and now fires) whenever
    // there's a draft OR staged attachments; an empty draft with attachments
    // sends a caption-less album, same as an empty draft with no attachments
    // used to just no-op.
    if (!draft.trim() && attachments.length === 0) return;
    if (sending) return; // belt-and-braces alongside the button's own `disabled`
    // Whether the composer already had focus decides whether we *keep* it
    // below — read before `onSend`, since sending can re-render this subtree.
    const hadFocus = document.activeElement === textareaRef.current;
    onSend();
    // Keep focus in the field so the on-screen keyboard doesn't collapse
    // after every send (user feedback: Samsung PWA dropped the keyboard and
    // forced a re-tap). The send button itself also suppresses its own
    // focus-steal via onPointerDown (see the JSX) — this refocus covers the
    // Enter-to-send path.
    // Only when the field *was* focused, though (user feedback, 2026-08-13):
    // sending staged media usually happens with the keyboard down — you pick
    // photos, then tap Send — and an unconditional focus() there yanked the
    // keyboard open on a composer the user had deliberately left alone.
    if (hadFocus) textareaRef.current?.focus();
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
    onAddFiles(files);
  }

  /** docs/IMAGE_PASTE.md — desktop Ctrl+V of a screenshot, or mobile
   *  long-press → Paste, land here as a `ClipboardEvent` with `.files`
   *  populated. No files → leave the event alone entirely (no
   *  `preventDefault()`) so plain text paste behaves exactly as before.
   *  Files present → this *is* the paste, even on a mixed clipboard (e.g.
   *  copied off a web page, file + filename text): we take the file and
   *  drop the text, matching Discord/Slack. Routes into the same
   *  `onAddFiles` the attach button uses — `ChatView`'s `stageFiles` already
   *  filters kinds and reports skips, so no filtering here.
   *  docs/MEDIA_ATTACHMENTS.md §5.1 — pasting while attachments are already
   *  staged now APPENDS instead of erroring ("Upload in progress" is gone as
   *  a concept: nothing uploads until Send).
   *  ⚠️ iOS Safari / Android Samsung Keyboard clipboard-image paste is
   *  unverified on real hardware — see PROJECT.md §12. */
  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    e.preventDefault();
    // docs/MESSAGE_EDIT.md §4.3 — an edit only ever touches `body`; a pasted
    // file is silently ignored (not routed into the staging path, no error
    // surfaced) rather than staged the way it is outside edit mode. Text
    // paste is unaffected either way (handled above, before this branch is
    // ever reached).
    if (editing) return;
    onAddFiles(Array.from(files));
  }

  // An album send is in flight, so Send is spent — the tray stays on screen
  // for the whole upload (docs/MEDIA_ATTACHMENTS.md §5.1: a failed send keeps
  // its files), which used to leave the button live and let a second tap send
  // the same photos again (user feedback, 2026-08-13). `uploading` alone
  // isn't enough: `ChatView` doesn't have upload progress to report until the
  // mint round-trip returns, whereas it flips the staged items to 'uploading'
  // synchronously, so that's what covers the gap. `ChatView.sendAlbum` holds
  // the authoritative in-flight guard; this is the affordance for it.
  // Scoped to attachment sends deliberately: a plain text Send has nothing in
  // flight to double-submit, and shouldn't go dead just because some *other*
  // upload (a voice message) is still running.
  const sending = attachments.length > 0 && (uploading || attachments.some((a) => a.status === 'uploading'));

  const lockProgress = clamp01(dragY / LOCK_THRESHOLD_DY);
  const cancelProgress = clamp01(dragX / CANCEL_THRESHOLD_DX);
  // Desktop shows explicit Stop/Cancel buttons for the whole recording
  // lifecycle (no gesture to protect); mobile only swaps to them once
  // locked, since the drag gesture up to that point lives entirely on the
  // mic button itself (see the trailing-slot JSX below).
  const showExplicitStopCancel = recState === 'locked' || (!isMobile && recState !== 'idle');

  // docs/EMBEDS.md §4.4 — recomputed on every draft keystroke/paste; cheap
  // (a couple of regex passes over one message-length string), and this is
  // exactly the "type or paste" detection surface the plan calls for.
  const detectedEmbed = useMemo(() => (recState === 'idle' && !editing ? detectEmbedUrl(draft) : null), [draft, recState, editing]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      // Phase-1 embeds turned this form into a vertical stack (the detected-
      // embed chip sits above the input row `div` below); the row's own
      // `flex items-end gap-2` moved onto that inner div.
      className="flex flex-col gap-1.5 border-t border-border bg-surface-raised p-3"
      // docs/IOS_KEYBOARD.md — keyboard closed (or the hook's gate is off,
      // i.e. not iOS): today's safe-area padding, unchanged. Keyboard open:
      // swap to the live `--kb-inset` px value and drop the safe-area
      // inset entirely — the home indicator is hidden behind the keyboard,
      // so adding both would double-count and leave a gap. Reads the CSS
      // var (not the `keyboardInset` number) once open so the padding
      // tracks every animation frame the hook writes, not just the frames
      // that happen to land a React re-render.
      style={{
        paddingBottom: keyboardInset > 0 ? 'var(--kb-inset, 0px)' : 'max(env(safe-area-inset-bottom), 0.75rem)',
      }}
    >
      <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple hidden onChange={handleFileInputChange} />

      {/* docs/MEDIA_ATTACHMENTS.md §5.1 — the attachment tray. Rendered
          *inside* this form, above the input row, so it inherits the
          `--kb-inset` iOS keyboard padding this form already carries (see
          the form's own `style` below) instead of needing a second copy of
          that logic. */}
      {attachments.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-0.5">
          {attachments.map((item) => (
            <AttachmentTrayThumb
              key={item.localId}
              item={item}
              onOpen={() => onOpenAttachment(item.localId)}
              onRemove={() => onRemoveAttachment(item.localId)}
            />
          ))}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Add another attachment"
            className="grid h-14 w-14 shrink-0 place-items-center rounded-md border border-dashed border-border text-text-muted"
            style={{ touchAction: 'manipulation' }}
          >
            <Plus size={18} />
          </button>
        </div>
      )}

      {detectedEmbed && (
        <p className="px-1 text-xs text-text-secondary">{EMBED_CHIP_LABEL[detectedEmbed.provider]}</p>
      )}

      <div className="flex items-end gap-2">

      {/* Leading slot: attach button while idle, an explicit Cancel button
          once recording has a Stop/Cancel pair (see showExplicitStopCancel).
          Hidden entirely in edit mode (docs/MESSAGE_EDIT.md §4.3) — an edit
          only ever touches `body`, never media. */}
      {editing ? null : recState === 'idle' ? (
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
          onFocus={onInputFocus}
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
          (no drag to protect in the first place). In edit mode
          (docs/MESSAGE_EDIT.md §4.3) it's the *only* trailing control —
          recState is always 'idle' there since the mic that drives every
          other recState is never rendered. */}
      {editing ? (
        <button
          type="submit"
          disabled={!draft.trim()}
          onPointerDown={(e) => e.preventDefault()}
          aria-label="Update message"
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-pill bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:bg-accent-hover disabled:opacity-40"
          style={{ touchAction: 'manipulation' }}
        >
          <Check size={15} />
          Update
        </button>
      ) : showExplicitStopCancel ? (
        <button
          type="button"
          onClick={finishRecording}
          aria-label="Stop and send recording"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-accent text-white transition-colors hover:bg-accent-hover active:bg-accent-hover"
          style={{ touchAction: 'manipulation' }}
        >
          <Square size={16} fill="currentColor" />
        </button>
      ) : recState === 'idle' && (draft.trim() || attachments.length > 0) ? (
        <button
          type="submit"
          disabled={sending}
          // Suppress the button's own focus-steal so tapping Send doesn't blur
          // the textarea and collapse the on-screen keyboard (user feedback:
          // Samsung PWA). The click/submit still fires normally; only the
          // default focus shift is cancelled.
          onPointerDown={(e) => e.preventDefault()}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-pill bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover active:bg-accent-hover disabled:opacity-40"
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
      </div>
    </form>
  );
}

/** One 56px tray thumbnail (docs/MEDIA_ATTACHMENTS.md §5.1). Images decode
 *  via `URL.createObjectURL`; videos use `<video preload="metadata" muted>`,
 *  which renders a first frame with no playback controls needed for a static
 *  thumb. `onerror` on either falls back to a plain file-icon tile — the
 *  HEIC-outside-Safari case (⚠️ iOS: this fallback path is the one that
 *  should *never* fire there, since Safari decodes HEIC object URLs natively
 *  — unverified on real hardware, PROJECT.md §12). Sensitivity marks blur the
 *  thumb via the one shared `SensitiveOverlay` and show a small `EyeOff`
 *  badge; tapping (blurred or not) always opens `AttachmentSheet` — there is
 *  no separate "peek" affordance out here in the tray. */
function AttachmentTrayThumb({
  item,
  onOpen,
  onRemove,
}: {
  item: StagedAttachment;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const sensitivity = sensitivityOf(item.tags);

  return (
    <div
      className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken"
      onContextMenu={suppressTouchContextMenu}
    >
      <SensitiveOverlay sensitivity={sensitivity} blurred={sensitivity !== null} onReveal={onOpen} compact className="h-full w-full">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Edit attachment — ${item.file.name}`}
          className="media-preview block h-14 w-14"
          style={{ touchAction: 'manipulation' }}
        >
          {previewFailed || !item.previewUrl ? (
            <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1 text-text-muted">
              <FileQuestion size={16} />
              <span className="w-full truncate text-center text-[9px] leading-tight">{item.file.name}</span>
            </span>
          ) : item.kind === 'image' ? (
            <img src={item.previewUrl} alt="" onError={() => setPreviewFailed(true)} className="h-full w-full object-cover" />
          ) : (
            <span className="relative block h-full w-full">
              <video src={item.previewUrl} preload="metadata" muted onError={() => setPreviewFailed(true)} className="h-full w-full object-cover" />
              <span className="pointer-events-none absolute inset-0 grid place-items-center bg-black/10">
                <Play size={14} fill="white" className="text-white" />
              </span>
            </span>
          )}
        </button>
      </SensitiveOverlay>
      {sensitivity && (
        <span className="pointer-events-none absolute left-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white">
          <EyeOff size={10} />
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove attachment"
        className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-pill bg-black/70 text-white"
        style={{ touchAction: 'manipulation' }}
      >
        <X size={10} />
      </button>
    </div>
  );
}
