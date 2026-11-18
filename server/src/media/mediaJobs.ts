/**
 * The process-wide media job queue (jobQueue.ts) and its lane policy. A
 * module of its own so service.ts (which asks "is a job in flight for this
 * id?") and pipeline.ts (which starts jobs and imports service.ts) don't
 * import each other.
 */
import type { MediaKind } from '@den/shared';
import { KeyedJobQueue } from './jobQueue.js';

type Lane = 'video' | 'light';

/**
 * ⚠️ Video concurrency is 1 on purpose: libx264 at `-preset veryfast` already
 * uses every core it can find, so two concurrent encodes on a small VPS don't
 * finish twice as much — they both crawl toward the 90s cap and fall back to
 * the original. Images (sharp, also multi-threaded but sub-second) and voice
 * (tiny ffmpeg runs) share a second lane so a queue of videos never makes a
 * photo wait minutes for its placeholder to resolve.
 */
export const mediaJobs = new KeyedJobQueue<Lane>({ video: 1, light: 2 });

export function laneFor(kind: MediaKind): Lane {
  return kind === 'video' ? 'video' : 'light';
}

export function isMediaJobInFlight(mediaId: bigint): boolean {
  return mediaJobs.has(mediaId.toString());
}
