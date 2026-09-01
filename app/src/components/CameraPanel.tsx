import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronUp, Image as ImageIcon, Lock, MicOff, RotateCcw, SwitchCamera } from 'lucide-react';
import { useBackHandler } from '../lib/backStack';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { IDLE, pressCancel, pressClick, pressDown, pressFire, type PressState } from '../lib/pressGesture';

/**
 * docs/CAMERA_COMPOSER.md §5 (photo) and §8 (video) — the in-app camera.
 *
 * **Tap the shutter for a photo, hold it for video.** Release stops and goes
 * to review; sliding up past the lock threshold goes hands-free, after which
 * only a tap on the shutter stops it. Container variance is a non-issue: the
 * server transcodes whatever the platform records to h264+aac mp4
 * (docs/VIDEO_TRANSCODE.md), exactly as it already does for voice, so this
 * passes `new MediaRecorder(stream)` with no options and lets each browser
 * pick its native container.
 *
 * This component knows nothing about uploads. A capture becomes a `File` and
 * goes out through `onFiles`, which `ChatView` points at the same
 * `handleAddFiles`/`stageFiles` path the attach button and clipboard paste
 * already use (invariant 2 — media bytes never transit the API server; this
 * is a client-side Blob until the existing album send picks it up).
 *
 * ⚠️ iOS, for the standing device gate (PROJECT.md §12): `getUserMedia` in an
 * installed PWA is the highest-risk unknown here, and the acquire below runs
 * from an effect on mount rather than synchronously inside the tap handler.
 * That should be fine — WebKit's transient activation is a ~5s window, not a
 * call-stack requirement, and an effect runs milliseconds after the tap — but
 * it is NOT the same guarantee `Composer`'s mic path goes out of its way to
 * get. If iOS refuses to prompt, the fix is known and cheap: hoist the
 * `getUserMedia` call into `ChatView`'s `onOpenCamera` handler (synchronous,
 * inside the gesture) and hand the resulting stream in as a prop.
 */

/** Height of the black strip below the feed. The feed deliberately does NOT
 *  fill the screen (owner's call) — letterboxing avoids fighting
 *  `object-cover` for the framing and gives the shutter a home. */
const STRIP_H = 112;
/** Shutter diameter. ~70% of it sits over the feed, ~30% over the strip. */
const SHUTTER_D = 72;
/** JPEG quality (D12). The server re-encodes to WebP regardless, so this is
 *  one lossy generation before an inevitable second — traded for upload size,
 *  since a 1080p PNG is ~3MB and this is a mobile-data app. */
const JPEG_QUALITY = 0.92;
/** D11 — preview is mirrored for the front camera (what a mirror does), but
 *  the captured file is NOT (what everyone else actually saw). A genuine
 *  toss-up, deliberately left as this one flag so re-judging it on a real
 *  selfie during the device pass is a one-word change. */
const MIRROR_FRONT_CAPTURE = false;

/** How long the shutter must be held before it starts recording instead of
 *  taking a photo. The mic button needs no equivalent because it has only one
 *  meaning; this button has two, and this is what separates them. */
const HOLD_TO_RECORD_MS = 300;
/** Hard ceiling on one clip. `MediaRecorder` left running is unbounded, and
 *  `MediaLimits.maxBytes.video` is 500MB — a time cap is the practical proxy,
 *  and 60s matches what every messenger allows in-line. Longer video still has
 *  a path: pick it from the gallery, where the real 500MB limit applies. */
const MAX_VIDEO_MS = 60_000;
/** Slide up past this to lock (hands-free). Deliberately the same value as
 *  `Composer`'s voice recorder, so muscle memory transfers between the two
 *  hold-to-record gestures — but kept as its own constant rather than shared,
 *  because if a device pass retunes one surface it should not silently drag
 *  the other along. There is intentionally NO slide-left-to-cancel here: the
 *  review step (Retake / Back) is already the escape hatch, and a second
 *  destructive drag on the same button is surface nobody asked for. */
const LOCK_THRESHOLD_DY = -115;

type Facing = 'environment' | 'user';
type Captured = { file: File; url: string; kind: 'image' | 'video' };
/** `locked` = recording hands-free; the finger is gone and only a tap on the
 *  shutter resolves it. */
type RecState = 'idle' | 'recording' | 'locked';

/** Best-effort haptic tick on crossing the lock threshold, mirroring
 *  `Composer`'s. Android Chrome supports the Vibration API; iOS Safari does
 *  not expose it at all, so this is a silent no-op there — feature-detected,
 *  never assumed. */
function haptic(ms: number): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
}

function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export function CameraPanel({
  onFiles,
  onClose,
}: {
  /** Captured photo or video, or a pick from the device gallery — all go to
   *  `ChatView.handleAddFiles`, so `stageFiles` enforces kind/size/the
   *  10-attachment cap centrally and this component owns no validation. */
  onFiles: (files: File[]) => void;
  onClose: () => void;
}) {
  useBackHandler(true, onClose, { escape: true });

  const [facing, setFacing] = useState<Facing>('environment');
  const [captured, setCaptured] = useState<Captured | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [recState, setRecState] = useState<RecState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lockProgress, setLockProgress] = useState(0);
  /** False when the mic was refused or absent but the camera worked — video
   *  still records, silently, and the UI says so rather than surprising
   *  someone with a mute clip. */
  const [audioAvailable, setAudioAvailable] = useState(true);
  /** Bumped to force the acquire effect to re-run after the stream was torn
   *  down for a backgrounded tab (see the visibility effect). */
  const [restartKey, setRestartKey] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Gesture bookkeeping. `pressRef` owns only the tap-vs-hold decision — see
  // lib/pressGesture.ts, reused here because this button has the *same*
  // hazard the GIF picker had: the click that follows a completed hold must
  // not also fire the tap action. There it would send a GIF; here it would
  // snap a photo on top of the video you just recorded.
  // `pressMove` is deliberately NOT used: that exists to abandon a pending
  // press when the surface underneath scrolls, and this panel has no
  // scroller. Movement here is a *meaningful* gesture (slide up to lock), not
  // a cancellation signal.
  const pressRef = useRef<PressState>(IDLE);
  const holdTimerRef = useRef<number | null>(null);
  const gestureRef = useRef<{ pointerId: number; startY: number } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /** Set before `stop()` when the clip must be thrown away rather than
   *  reviewed — unmounting mid-recording. Mirrors `Composer`'s `discardRef`. */
  const discardRef = useRef(false);
  const recTimerRef = useRef<number | null>(null);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function clearHoldTimer() {
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  }

  function clearRecTimer() {
    if (recTimerRef.current !== null) window.clearInterval(recTimerRef.current);
    recTimerRef.current = null;
  }

  // Acquire the camera. Keyed on `captured` too, which is what makes the
  // review state free: entering review runs this cleanup (tracks stopped, no
  // camera indicator burning while the user decides), and Retake re-runs it.
  useEffect(() => {
    if (captured) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      // `width`/`height` are HINTS, never guarantees (D2) — the real
      // dimensions are read back off the element at capture time.
      const video = { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } };
      let stream: MediaStream | null = null;
      let withAudio = true;
      try {
        // Audio is requested up front, not when a recording starts: prompting
        // mid-hold would interrupt the very gesture that triggered it, and on
        // iOS would almost certainly lose the recording.
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
      } catch {
        // Mic refused or absent must never cost you the camera. Retry without
        // it and downgrade to silent video rather than failing outright.
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video });
          withAudio = false;
        } catch (err) {
          if (cancelled) return;
          const name = err instanceof Error ? err.name : '';
          setError(
            name === 'NotAllowedError'
              ? 'Camera access is off for this site. Enable it in your browser settings.'
              : name === 'NotFoundError'
                ? 'No camera found on this device.'
                : "Couldn't start the camera.",
          );
          return;
        }
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setAudioAvailable(withAudio);
      setError(null);
      const el = videoRef.current;
      if (el) {
        el.srcObject = stream;
        // Safari rejects this promise on interruption (a fast close/switch);
        // that is not an error worth surfacing.
        void el.play().catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, [facing, captured, restartKey]);

  // A live camera track in a backgrounded PWA is a battery and privacy
  // problem, and iOS is the platform least likely to forgive it. Drop the
  // tracks on hide; re-acquire on show (the acquire effect early-returns on
  // its own if we're sitting in the review state).
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        // A recording in flight is finished rather than dropped — the bytes
        // so far are real and the review step can still deal with them.
        if (recorderRef.current && recorderRef.current.state !== 'inactive') finishRecording();
        stopStream();
        setReady(false);
      } else {
        setRestartKey((k) => k + 1);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount/unmount only; the handler reads refs, not state
  }, []);

  // Full teardown on unmount (the user backs out mid-recording, or switches
  // chats) — discards rather than reviewing a stray clip, and releases the
  // camera and mic either way.
  useEffect(() => {
    return () => {
      discardRef.current = true;
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
      clearHoldTimer();
      clearRecTimer();
      stopStream();
    };
  }, []);

  // One revoke covering every exit: Retake (url changes), Done and Back
  // (unmount). Leaking an object URL per capture is exactly the bug the
  // composer tray's lifecycle effects exist to prevent.
  useEffect(() => {
    const url = captured?.url;
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [captured?.url]);

  /**
   * D15 — what you see is what you get. The preview is `object-cover` inside
   * a letterboxed box, so the track is bigger than what's on screen; drawing
   * the whole frame would hand back framing the user never saw. This
   * reproduces `object-cover`'s own arithmetic to find the visible source
   * rect, and never upscales (the canvas is sized in *video* pixels).
   */
  function capturePhoto() {
    const video = videoRef.current;
    const box = feedRef.current;
    if (!video || !box || !video.videoWidth || !video.videoHeight) return;

    const cw = box.clientWidth;
    const ch = box.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const scale = Math.max(cw / vw, ch / vh); // object-cover: cover the box
    const sw = Math.round(cw / scale);
    const sh = Math.round(ch / scale);
    const sx = Math.round((vw - sw) / 2);
    const sy = Math.round((vh - sh) / 2);

    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setError("Couldn't capture that frame.");
      return;
    }
    // Note the default is a no-op: `drawImage` reads the *un-mirrored* track
    // (a CSS transform on the element doesn't touch pixel data), so
    // un-mirrored output costs nothing and mirroring is the opt-in.
    if (facing === 'user' && MIRROR_FRONT_CAPTURE) {
      ctx.translate(sw, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("Couldn't capture that frame.");
          return;
        }
        // The explicit type matters: `kindForMime` reads it and `stageFiles`
        // rejects anything that isn't image/video.
        const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
        setCaptured({ file, url: URL.createObjectURL(blob), kind: 'image' });
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
  }

  function beginRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    try {
      // No `mimeType` option, exactly as the voice path does it: the platform
      // picks its native container (Safari mp4, Chrome webm) and the server
      // normalizes. Choosing here would mean an `isTypeSupported` ladder that
      // buys nothing.
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      discardRef.current = false;
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const discarded = discardRef.current;
        discardRef.current = false;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (discarded || chunks.length === 0) return;
        const type = (rec.mimeType || 'video/webm').split(';')[0]!; // drop the ;codecs= parameter
        const blob = new Blob(chunks, { type });
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([blob], `camera-${Date.now()}.${ext}`, { type });
        setCaptured({ file, url: URL.createObjectURL(blob), kind: 'video' });
      };
      recorderRef.current = rec;
      rec.start();
      setElapsedMs(0);
      const startedAt = Date.now();
      recTimerRef.current = window.setInterval(() => {
        const ms = Date.now() - startedAt;
        setElapsedMs(ms);
        if (ms >= MAX_VIDEO_MS) finishRecording();
      }, 100);
      setRecState('recording');
      haptic(20);
    } catch {
      setError("Couldn't start recording.");
    }
  }

  /** Stop and keep — `onstop` builds the file and flips into review, which in
   *  turn tears the stream down via the acquire effect's cleanup. */
  function finishRecording() {
    const rec = recorderRef.current;
    recorderRef.current = null;
    clearRecTimer();
    setLockProgress(0);
    setRecState('idle');
    if (rec && rec.state !== 'inactive') rec.stop();
  }

  function lockRecording() {
    haptic(30);
    gestureRef.current = null;
    setLockProgress(0);
    setRecState('locked');
  }

  // --- Shutter gesture. Tap → photo (resolved on click, so a completed hold
  // can suppress it); hold → video; slide up while recording → lock. ---

  function onShutterPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setPressed(true);
    // Already recording hands-free: this press is the user reaching to stop.
    // Arming a second hold timer here would try to start a second recorder.
    // `pressRef` stays IDLE so the click that follows reads as a real tap.
    if (recState !== 'idle') return;
    pressRef.current = pressDown(e.clientX, e.clientY);
    gestureRef.current = { pointerId: e.pointerId, startY: e.clientY };
    clearHoldTimer();
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      pressRef.current = pressFire(pressRef.current);
      beginRecording();
    }, HOLD_TO_RECORD_MS);
  }

  function onShutterPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId || recState !== 'recording') return;
    const dy = Math.min(0, e.clientY - g.startY);
    setLockProgress(Math.min(1, Math.max(0, dy / LOCK_THRESHOLD_DY)));
    if (dy <= LOCK_THRESHOLD_DY) lockRecording();
  }

  function onShutterPointerUp() {
    setPressed(false);
    clearHoldTimer();
    gestureRef.current = null;
    pressRef.current = pressCancel(pressRef.current);
    // Locked recordings ignore the release entirely — only a tap stops them.
    if (recState === 'recording') finishRecording();
  }

  function onShutterPointerCancel() {
    setPressed(false);
    clearHoldTimer();
    gestureRef.current = null;
    pressRef.current = pressCancel(pressRef.current);
    // The browser took the gesture (an edge swipe, a system sheet). Keep what
    // was recorded rather than binning it — review can still discard.
    if (recState === 'recording') finishRecording();
  }

  function onShutterClick() {
    // Consume suppression FIRST. A completed hold always produces a trailing
    // click, and that click must be swallowed whether the recording already
    // stopped (unlocked release) or is still running (locked) — otherwise
    // locking and lifting your finger would instantly stop the recording you
    // just went hands-free with.
    const { state, send } = pressClick(pressRef.current);
    pressRef.current = state;
    if (!send) return;
    if (recState === 'locked') {
      finishRecording();
      return;
    }
    capturePhoto();
  }

  function useCaptured() {
    if (!captured) return;
    onFiles([captured.file]);
    onClose();
  }

  function handleGalleryPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    onFiles(files);
    onClose();
  }

  const mirrored = facing === 'user';
  const recording = recState !== 'idle';
  const progress = Math.min(1, elapsedMs / MAX_VIDEO_MS);
  const ringR = (SHUTTER_D - 3) / 2;
  const ringC = 2 * Math.PI * ringR;

  const content = (
    <div className="fixed inset-0 flex flex-col bg-black" style={{ zIndex: 100 }}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={handleGalleryPick}
      />

      {/* Feed box — flex-1, so the strip below is the only fixed height. */}
      <div ref={feedRef} className="relative flex-1 overflow-hidden bg-black">
        {error ? (
          // Never a dead end: the gallery path stays reachable from inside the
          // failure state, which is also why the shortcut exists in the normal
          // one (§5.3).
          <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
            <p className="text-sm text-white/80">{error}</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-pill bg-white/15 px-4 py-2 text-sm font-semibold text-white"
              style={{ touchAction: 'manipulation' }}
            >
              Choose from gallery
            </button>
          </div>
        ) : captured ? (
          captured.kind === 'image' ? (
            <img
              src={captured.url}
              alt="Captured photo"
              // `.media-preview` + the contextmenu suppressor, like every other
              // in-app media preview (PROJECT.md §14, 2026-07-22): without them a
              // long-press raises the browser's own save/share sheet over our UI.
              className="media-preview h-full w-full object-contain"
              onContextMenu={suppressTouchContextMenu}
            />
          ) : (
            // `controls` rather than an autoplaying muted loop on purpose: the
            // point of review is deciding whether to keep it, and you cannot
            // judge a clip whose audio you are not allowed to hear.
            <video
              src={captured.url}
              controls
              playsInline
              className="media-preview h-full w-full object-contain"
              onContextMenu={suppressTouchContextMenu}
            />
          )
        ) : (
          <video
            ref={videoRef}
            // ⚠️ `playsInline` is not optional — without it iOS takes the feed
            // fullscreen into its native player the moment it starts.
            playsInline
            muted
            autoPlay
            onLoadedMetadata={() => setReady(true)}
            className="h-full w-full object-cover"
            style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
          />
        )}

        {/* Back — top-left, over the feed, present in every state. A back
            arrow rather than an ✕ (owner, 2026-09-01): this is a surface you
            navigate out of, not a dialog you dismiss, and the arrow says so.
            Same treatment as every other full-screen surface (`ScreenHeader`,
            `GifPanel`, mobile Stage/search). */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to chat"
          className="absolute left-3 top-3 grid h-10 w-10 place-items-center rounded-pill bg-black/40 text-white"
          style={{ touchAction: 'manipulation', paddingTop: 0, marginTop: 'env(safe-area-inset-top)' }}
        >
          <ArrowLeft size={20} />
        </button>

        {/* Recording readout — elapsed against the 60s cap. */}
        {recording && (
          <div
            className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-pill bg-black/55 px-3 py-1.5 text-sm font-semibold tabular-nums text-white"
            style={{ marginTop: 'env(safe-area-inset-top)' }}
          >
            <span className="h-2 w-2 animate-pulse rounded-pill bg-red-500" />
            {formatElapsed(elapsedMs)}
            {recState === 'locked' && <Lock size={13} />}
          </div>
        )}

        {/* Silent-video warning — only when the mic was refused or absent.
            Better a standing label than a muted clip nobody expected. */}
        {!error && !captured && !audioAvailable && (
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-pill bg-black/55 px-3 py-1.5 text-xs text-white/90">
            <MicOff size={13} />
            No microphone — video will be silent
          </div>
        )}
      </div>

      {/* Black strip. Short on purpose — the shutter straddles the boundary
          rather than sitting inside it, so the strip doesn't have to be tall
          enough to contain it. */}
      <div
        className="relative shrink-0 bg-black"
        style={{ height: STRIP_H, paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {!error && !captured && !recording && (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Choose from gallery"
              className="absolute left-6 grid h-11 w-11 place-items-center rounded-pill text-white/90 transition-colors active:bg-white/10"
              style={{ bottom: STRIP_H / 2 - 22, touchAction: 'manipulation' }}
            >
              <ImageIcon size={24} />
            </button>
            <button
              type="button"
              onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}
              aria-label="Switch camera"
              className="absolute right-6 grid h-11 w-11 place-items-center rounded-pill text-white/90 transition-colors active:bg-white/10"
              style={{ bottom: STRIP_H / 2 - 22, touchAction: 'manipulation' }}
            >
              <SwitchCamera size={24} />
            </button>
          </>
        )}

        {/* Hold-to-record hint, shown only in the resting state so it teaches
            the gesture without nagging. */}
        {!error && !captured && !recording && ready && (
          <p className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] text-white/45">
            Tap for photo · hold for video
          </p>
        )}

        {recState === 'locked' && (
          <p className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[11px] text-white/60">Tap to stop</p>
        )}

        {captured && (
          <>
            <button
              type="button"
              onClick={() => setCaptured(null)}
              className="absolute left-6 flex h-11 items-center gap-2 rounded-pill px-3 text-sm font-semibold text-white/90 transition-colors active:bg-white/10"
              style={{ bottom: STRIP_H / 2 - 22, touchAction: 'manipulation' }}
            >
              <RotateCcw size={18} />
              Retake
            </button>
            <button
              type="button"
              onClick={useCaptured}
              className="absolute right-6 flex h-11 items-center gap-1.5 rounded-pill bg-accent px-5 text-sm font-semibold text-white transition-colors active:bg-accent-hover"
              style={{ bottom: STRIP_H / 2 - 22, touchAction: 'manipulation' }}
            >
              <Check size={17} />
              Done
            </button>
          </>
        )}
      </div>

      {/* Slide-up-to-lock affordance — rises toward the finger as the drag
          climbs, then snaps solid once armed. Mirrors `RecordingBar`'s lock
          chevron so the two hold-to-record gestures read the same. */}
      {recState === 'recording' && lockProgress > 0.05 && (
        <span
          className={
            'absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-0.5 rounded-pill px-2 py-1.5 ' +
            (lockProgress >= 1 ? 'bg-white/20 text-white' : 'text-white/70')
          }
          style={{
            bottom: `calc(${STRIP_H + SHUTTER_D * 0.7 + 12}px + env(safe-area-inset-bottom))`,
            transform: `translateX(-50%) translateY(${-lockProgress * 18}px) scale(${1 + lockProgress * 0.4})`,
          }}
          aria-hidden
        >
          <ChevronUp size={12} className="animate-pulse" />
          <Lock size={16} fill={lockProgress >= 1 ? 'currentColor' : 'none'} />
        </span>
      )}

      {/* Shutter — anchored to the OUTER container so it can straddle the
          feed/strip boundary (D5): ~70% over the video, ~30% on the black.
          The ring is a separate element from the fill on purpose: idle it is a
          plain white ring, recording it becomes the elapsed-time arc. */}
      {!error && !captured && (
        <button
          type="button"
          onClick={onShutterClick}
          onPointerDown={onShutterPointerDown}
          onPointerMove={onShutterPointerMove}
          onPointerUp={onShutterPointerUp}
          onPointerCancel={onShutterPointerCancel}
          disabled={!ready && !recording}
          aria-label={recState === 'locked' ? 'Stop recording' : 'Take photo, or hold to record video'}
          className="absolute left-1/2 grid place-items-center rounded-pill transition-opacity disabled:opacity-40"
          style={{
            width: SHUTTER_D,
            height: SHUTTER_D,
            marginLeft: -SHUTTER_D / 2,
            bottom: `calc(${STRIP_H - SHUTTER_D * 0.3}px + env(safe-area-inset-bottom))`,
            // ⚠️ `none`, not `manipulation` (PROJECT.md §12, measured
            // 2026-08-31): `manipulation` lets the compositor claim the touch
            // at its own slop and fire pointercancel before the slide-up-to-
            // lock threshold can ever engage.
            touchAction: 'none',
          }}
        >
          {recording ? (
            <svg
              className="absolute inset-0 -rotate-90"
              width={SHUTTER_D}
              height={SHUTTER_D}
              aria-hidden
            >
              <circle cx={SHUTTER_D / 2} cy={SHUTTER_D / 2} r={ringR} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={3} />
              <circle
                cx={SHUTTER_D / 2}
                cy={SHUTTER_D / 2}
                r={ringR}
                fill="none"
                stroke="#ef4444"
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray={ringC}
                strokeDashoffset={ringC * (1 - progress)}
              />
            </svg>
          ) : (
            <span
              className="absolute inset-0 rounded-pill border-[3px] border-white transition-transform duration-150"
              style={{ transform: pressed ? 'scale(1.06)' : 'scale(1)' }}
            />
          )}
          <span
            className={
              'transition-all duration-150 ' + (recording ? 'rounded-md bg-red-500' : 'rounded-pill bg-white')
            }
            style={
              recording
                ? { width: 26, height: 26 }
                : { width: SHUTTER_D - 14, height: SHUTTER_D - 14, transform: pressed ? 'scale(0.86)' : 'scale(1)' }
            }
          />
        </button>
      )}
    </div>
  );

  // Portalled to <body> with an EXPLICIT zIndex on the outermost wrapper —
  // PROJECT.md §11's hard-won lesson: a `position: fixed` element with
  // `z-index: auto` paints at its PARENT's layer, and this mounts from inside
  // the chat subtree where message blocks carry `relative z-10`.
  return createPortal(content, document.body);
}
