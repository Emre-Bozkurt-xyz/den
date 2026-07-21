import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { MediaInfo } from '@den/shared';
import { cachedPeaks, loadPeaks, PEAK_COUNT, placeholderPeaks } from '../lib/waveform';

/**
 * Custom voice-message player (docs/UI_REVAMP.md UI-7) — replaces the native
 * `<audio controls>` widget, which rendered as an opaque browser-chrome slab
 * that ignored the bubble's colors and looked different on every platform.
 *
 * Everything here draws in `currentColor` at varying opacity, so the same
 * component blends into the accent-filled "mine" bubble and the sunken
 * "theirs" bubble without branching on ownership.
 *
 * Bars are centered and mirrored about the middle of the row: a bar's div is
 * vertically centered by the flex container, so growing its height extends it
 * equally up and down — no second mirrored copy to keep in sync.
 *
 * ⚠️ iOS: `audio.play()` is called synchronously inside the click handler and
 * the waveform decode is fired off separately afterwards — the decode must
 * never be awaited before play, or Safari drops the user-gesture association
 * and refuses to start playback. See lib/waveform.ts for why decoding uses an
 * OfflineAudioContext.
 */

const BAR_MIN_SCALE = 0.06; // matches lib/waveform.ts's floor — a hairline, never a gap

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const total = Math.floor(sec);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

export function VoiceMessage({ media, interactive = true }: { media: MediaInfo; interactive?: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(() => cachedPeaks(media.id));
  const [real, setReal] = useState(() => cachedPeaks(media.id) !== null);

  // `durationMs` comes from the server's ffprobe pass and is available before
  // a single byte of audio is fetched; the element's own duration only
  // arrives with metadata, and is `Infinity`/NaN for some streamed sources.
  const durationSec =
    audioDuration ?? (media.durationMs != null ? media.durationMs / 1000 : null);
  const bars = peaks ?? placeholderPeaks(media.id, PEAK_COUNT);
  const progress = durationSec && durationSec > 0 ? Math.min(1, elapsed / durationSec) : 0;

  // Smooth playhead: `timeupdate` only fires ~4x/sec, which visibly steps the
  // fill across a 44-bar waveform. rAF runs only while actually playing.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const el = audioRef.current;
      if (el) setElapsed(el.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing]);

  // Navigating away mid-playback must not leave audio running (the element is
  // removed from the DOM but the media resource can outlive the node).
  useEffect(() => {
    const el = audioRef.current;
    return () => {
      el?.pause();
    };
  }, []);

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    // Synchronous play() first — see the iOS note in the file header.
    void el.play().catch(() => setPlaying(false));
    if (!real && media.url) {
      void loadPeaks(media.id, media.url).then((p) => {
        if (p) {
          setPeaks(p);
          setReal(true);
        }
      });
    }
  }

  function seekToClientX(clientX: number) {
    const el = audioRef.current;
    const wave = waveRef.current;
    if (!el || !wave || !durationSec) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    el.currentTime = ratio * durationSec;
    setElapsed(el.currentTime);
  }

  return (
    <div className="flex min-w-[200px] max-w-full items-center gap-2.5 py-0.5">
      <audio
        ref={audioRef}
        preload="metadata"
        src={media.url ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setElapsed(0);
        }}
        onTimeUpdate={(e) => setElapsed(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setAudioDuration(d);
        }}
        className="hidden"
      />

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
        // Selection mode owns every tap on the bubble (see ChatView) — the
        // control goes inert rather than disappearing, so the bubble doesn't
        // change shape when multi-select is entered.
        disabled={!interactive || !media.url}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-current/15 transition-opacity disabled:opacity-60"
        style={{ touchAction: 'manipulation' }}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
      </button>

      <div
        ref={waveRef}
        role="slider"
        aria-label="Seek voice message"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec ?? 0)}
        aria-valuenow={Math.round(elapsed)}
        aria-valuetext={formatTime(elapsed)}
        tabIndex={interactive ? 0 : -1}
        onClick={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          seekToClientX(e.clientX);
        }}
        onKeyDown={(e) => {
          const el = audioRef.current;
          if (!interactive || !el || !durationSec) return;
          if (e.key === 'ArrowLeft') el.currentTime = Math.max(0, el.currentTime - 5);
          else if (e.key === 'ArrowRight') el.currentTime = Math.min(durationSec, el.currentTime + 5);
          else return;
          e.preventDefault();
          setElapsed(el.currentTime);
        }}
        className="flex h-8 min-w-0 flex-1 items-center gap-[2px] outline-none"
        style={{ touchAction: 'manipulation' }}
      >
        {bars.map((v, i) => {
          // Played bars are solid, unplayed are ghosted; the placeholder
          // pattern is ghosted throughout so it never reads as real data.
          const played = i / bars.length < progress;
          return (
            <span
              key={i}
              className="min-w-[2px] flex-1 rounded-pill bg-current"
              style={{
                height: `${Math.max(BAR_MIN_SCALE, v) * 100}%`,
                opacity: real ? (played ? 1 : 0.4) : played ? 0.55 : 0.25,
              }}
            />
          );
        })}
      </div>

      <span className="shrink-0 text-xs tabular-nums opacity-70">
        {formatTime(elapsed > 0 ? elapsed : (durationSec ?? 0))}
      </span>
    </div>
  );
}
