/**
 * Voice-message waveform peaks — legacy-row fallback decoder
 * (docs/VOICE_WAVEFORM.md; original client-side design was
 * docs/archive/UI_REVAMP.md UI-7).
 *
 * Waveforms are now computed *server-side* at processing time and arrive on
 * `MediaInfo.waveform`, so the bubble normally never touches this module. It
 * survives only as a self-heal for rows without stored peaks (media processed
 * before the column existed and not yet backfilled, or a processing pass
 * whose ffmpeg peak step failed): on first play, fetch + decode the audio and
 * bucket it client-side — same RMS algorithm the server now runs.
 *
 * ⚠️ iOS: decoding goes through `OfflineAudioContext`, not a live
 * `AudioContext`, specifically so it never trips Safari's autoplay/gesture
 * policy — an OfflineAudioContext is only ever used here as a decoder and is
 * never started, so it needs no user gesture and no `resume()`. Callers must
 * still call `audio.play()` synchronously inside the click handler and let
 * this resolve afterwards (see VoiceMessage.tsx).
 */
import { VOICE_WAVEFORM_BARS } from '@den/shared';

// mediaId → peaks. Module-level so scrolling a bubble out of view and back
// (or remounting via the chat's message list) doesn't re-download/re-decode.
const cache = new Map<string, number[]>();
// mediaId → in-flight decode, so a double-tap on play can't start two fetches.
const inFlight = new Map<string, Promise<number[] | null>>();

export function cachedPeaks(mediaId: string): number[] | null {
  return cache.get(mediaId) ?? null;
}

function makeOfflineContext(): OfflineAudioContext | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- webkit-prefixed fallback isn't in lib.dom
  const Ctor: any = window.OfflineAudioContext ?? (window as any).webkitOfflineAudioContext;
  if (!Ctor) return null;
  // 1 channel / 1 frame: this context is only ever a decoder, never rendered.
  return new Ctor(1, 1, 44100) as OfflineAudioContext;
}

function decode(ctx: OfflineAudioContext, buf: ArrayBuffer): Promise<AudioBuffer> {
  // Safari historically only had the callback form; 16.4+ (our floor) has the
  // promise form, but honoring both costs three lines and removes a whole
  // class of "works on Android, silently no bars on iOS" bug.
  return new Promise((resolve, reject) => {
    const maybe = ctx.decodeAudioData(buf, resolve, reject);
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

/** Downsample to `count` bars using per-bucket RMS (not peak-absolute) —
 *  RMS tracks perceived loudness, so speech reads as a body of sound rather
 *  than a row of spikes at every consonant. Normalized to the loudest bucket
 *  so quiet recordings still fill the bubble. */
function toPeaks(audio: AudioBuffer, count: number): number[] {
  const data = audio.getChannelData(0);
  const bucket = Math.max(1, Math.floor(data.length / count));
  const out: number[] = [];
  let max = 0;
  for (let i = 0; i < count; i++) {
    const start = i * bucket;
    const end = Math.min(start + bucket, data.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j]! * data[j]!;
    const rms = end > start ? Math.sqrt(sum / (end - start)) : 0;
    if (rms > max) max = rms;
    out.push(rms);
  }
  if (max <= 0) return out.map(() => 0.05);
  // Floor at 0.06 so silent stretches still draw a hairline instead of a gap.
  return out.map((v) => Math.max(0.06, v / max));
}

/** Fetch + decode a voice clip's peaks. Resolves `null` (never throws) if
 *  anything goes wrong — a missing waveform is a cosmetic degradation, and
 *  playback itself is handled by a separate <audio> element that doesn't
 *  depend on any of this. Both requests hit the same presigned URL, so the
 *  HTTP cache generally serves this from the <audio> element's own fetch. */
export function loadPeaks(mediaId: string, url: string, count: number = VOICE_WAVEFORM_BARS): Promise<number[] | null> {
  const hit = cache.get(mediaId);
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(mediaId);
  if (pending) return pending;

  const task = (async () => {
    try {
      const ctx = makeOfflineContext();
      if (!ctx) return null;
      // No credentials — the presigned URL's signature is the auth (hard
      // invariant 2), same posture as lib/media.ts's upload PUT.
      const res = await fetch(url);
      if (!res.ok) return null;
      const peaks = toPeaks(await decode(ctx, await res.arrayBuffer()), count);
      cache.set(mediaId, peaks);
      return peaks;
    } catch {
      return null;
    } finally {
      inFlight.delete(mediaId);
    }
  })();

  inFlight.set(mediaId, task);
  return task;
}
