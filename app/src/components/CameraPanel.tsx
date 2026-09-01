import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Image as ImageIcon, RotateCcw, SwitchCamera } from 'lucide-react';
import { useBackHandler } from '../lib/backStack';
import { suppressTouchContextMenu } from '../lib/nativeMenu';

/**
 * docs/CAMERA_COMPOSER.md §5 — the in-app camera.
 *
 * Photo only (D3): all of the platform risk lives in video (MediaRecorder
 * with a video track on iOS, baked-in stream orientation, unbounded duration
 * against the 500MB ceiling), and photo-only never asks for the microphone,
 * so this prompts for exactly one permission. Phase 2 is §8 of that doc —
 * the shutter's ring is a separate element specifically so it can become a
 * recording progress ring without restructuring the button.
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

type Facing = 'environment' | 'user';
type Captured = { file: File; url: string };

export function CameraPanel({
  onFiles,
  onClose,
}: {
  /** Captured photo, or a pick from the device gallery — both go to
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
  /** Bumped to force the acquire effect to re-run after the stream was torn
   *  down for a backgrounded tab (see the visibility effect). */
  const [restartKey, setRestartKey] = useState(0);

  const videoRef = useRef<HTMLVideoElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // Acquire the camera. Keyed on `captured` too, which is what makes the
  // review state free: entering review runs this cleanup (tracks stopped, no
  // camera indicator burning while the user decides), and Retake re-runs it.
  useEffect(() => {
    if (captured) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      try {
        // `width`/`height` are HINTS, never guarantees (D2) — the real
        // dimensions are read back off the element at capture time.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        setError(null);
        const el = videoRef.current;
        if (el) {
          el.srcObject = stream;
          // Safari rejects this promise on interruption (a fast close/switch);
          // that is not an error worth surfacing.
          void el.play().catch(() => {});
        }
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
        stopStream();
        setReady(false);
      } else {
        setRestartKey((k) => k + 1);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // One revoke covering every exit: Retake (url changes), Done and Close
  // (unmount). Leaking an object URL per photo is exactly the bug the
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
  function capture() {
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
        setCaptured({ file, url: URL.createObjectURL(blob) });
      },
      'image/jpeg',
      JPEG_QUALITY,
    );
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
      </div>

      {/* Black strip. Short on purpose — the shutter straddles the boundary
          rather than sitting inside it, so the strip doesn't have to be tall
          enough to contain it. */}
      <div
        className="relative shrink-0 bg-black"
        style={{ height: STRIP_H, paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {!error && !captured && (
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

      {/* Shutter — anchored to the OUTER container so it can straddle the
          feed/strip boundary (D5): ~70% over the video, ~30% on the black.
          The ring is a separate element from the fill on purpose — phase 2's
          recording progress draws on it (§8) — and both react to the press so
          the button feels alive under the thumb. */}
      {!error && !captured && (
        <button
          type="button"
          onClick={capture}
          onPointerDown={() => setPressed(true)}
          onPointerUp={() => setPressed(false)}
          onPointerCancel={() => setPressed(false)}
          onPointerLeave={() => setPressed(false)}
          disabled={!ready}
          aria-label="Take photo"
          className="absolute left-1/2 grid place-items-center rounded-pill transition-opacity disabled:opacity-40"
          style={{
            width: SHUTTER_D,
            height: SHUTTER_D,
            marginLeft: -SHUTTER_D / 2,
            bottom: `calc(${STRIP_H - SHUTTER_D * 0.3}px + env(safe-area-inset-bottom))`,
            touchAction: 'manipulation',
          }}
        >
          <span
            className="absolute inset-0 rounded-pill border-[3px] border-white transition-transform duration-150"
            style={{ transform: pressed ? 'scale(1.06)' : 'scale(1)' }}
          />
          <span
            className="rounded-pill bg-white transition-transform duration-150"
            style={{ width: SHUTTER_D - 14, height: SHUTTER_D - 14, transform: pressed ? 'scale(0.86)' : 'scale(1)' }}
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
