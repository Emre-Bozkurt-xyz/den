/**
 * Server-side voice waveform peaks (docs/VOICE_WAVEFORM.md).
 *
 * Computed once at processing time from the transcoded m4a and stored on the
 * media row, so the client renders the real waveform the moment the bubble
 * mounts — no fetching/decoding audio just to draw bars, and no placeholder
 * facade. The bucketing mirrors the client's original decoder
 * (app/src/lib/waveform.ts, kept as a legacy-row fallback): per-bucket RMS
 * rather than peak-absolute — RMS tracks perceived loudness, so speech reads
 * as a body of sound instead of a row of consonant spikes — normalized to the
 * loudest bucket so quiet recordings still fill the bubble.
 *
 * Stored quantized to 0–255 ints: 44 small numbers per row, and the client's
 * bar heights are ~30px tall, so 8 bits of amplitude is already more
 * resolution than the UI can show.
 */
import { VOICE_WAVEFORM_BARS } from '@den/shared';

/** Bucket raw mono s16le PCM into `count` normalized RMS peaks, 0–255. */
export function pcmToPeaks(pcm: Buffer, count: number = VOICE_WAVEFORM_BARS): number[] {
  const samples = Math.floor(pcm.length / 2); // s16le: 2 bytes per sample
  if (samples < 1) return new Array<number>(count).fill(0);

  const bucket = Math.max(1, Math.floor(samples / count));
  const rms: number[] = [];
  let max = 0;
  for (let i = 0; i < count; i++) {
    const start = i * bucket;
    const end = Math.min(start + bucket, samples);
    let sum = 0;
    for (let j = start; j < end; j++) {
      const v = pcm.readInt16LE(j * 2) / 32768;
      sum += v * v;
    }
    const value = end > start ? Math.sqrt(sum / (end - start)) : 0;
    if (value > max) max = value;
    rms.push(value);
  }
  if (max <= 0) return rms.map(() => 0); // digital silence — client draws its hairline floor
  return rms.map((v) => Math.round((v / max) * 255));
}
