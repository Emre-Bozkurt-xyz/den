/**
 * Voice-message waveform peaks (docs/UI_REVAMP.md UI-7).
 *
 * Peaks are computed *client-side* — there is no `peaks` column and nothing
 * about this touches the schema, the API, or `MediaInfo`. The bubble renders
 * a deterministic placeholder pattern immediately, then swaps in real peaks
 * once the audio has been fetched and decoded (kicked off on first play, so
 * opening a chat full of voice notes doesn't download all of them).
 *
 * ⚠️ iOS: decoding goes through `OfflineAudioContext`, not a live
 * `AudioContext`, specifically so it never trips Safari's autoplay/gesture
 * policy — an OfflineAudioContext is only ever used here as a decoder and is
 * never started, so it needs no user gesture and no `resume()`. Callers must
 * still call `audio.play()` synchronously inside the click handler and let
 * this resolve afterwards (see VoiceMessage.tsx).
 */

/** Bar count in the bubble. Fixed rather than width-derived so the
 *  placeholder→real swap can't also change the bar layout. */
export const PEAK_COUNT = 44;

// mediaId → peaks. Module-level so scrolling a bubble out of view and back
// (or remounting via the chat's message list) doesn't re-download/re-decode.
const cache = new Map<string, number[]>();
// mediaId → in-flight decode, so a double-tap on play can't start two fetches.
const inFlight = new Map<string, Promise<number[] | null>>();

/** FNV-1a — small, fast, and stable across reloads (unlike anything seeded
 *  from Math.random), so a given voice message always draws the same
 *  placeholder bars instead of shuffling on every render. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Decorative bars shown before (or instead of) a real decode. Deliberately
 *  mid-range and gently varied — it should read as "waveform not loaded yet",
 *  never as a confident claim about the audio. */
export function placeholderPeaks(seed: string, count: number = PEAK_COUNT): number[] {
  let state = hash(seed) || 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // xorshift32 — deterministic per seed, no dependency on Math.random.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push(0.25 + (state / 0xffffffff) * 0.45);
  }
  return out;
}

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
export function loadPeaks(mediaId: string, url: string, count: number = PEAK_COUNT): Promise<number[] | null> {
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
