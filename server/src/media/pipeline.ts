/**
 * "Process, then broadcast" — the one way media processing is started (audit
 * fix 2026-11-18). Shared by the upload-complete route (routes/media.ts) and
 * the sweeper (sweeper.ts) so a recovered job announces itself exactly the
 * way a fresh one does.
 *
 * Jobs go through the bounded queue in mediaJobs.ts, which also guarantees at
 * most one job per media id is ever queued or running.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Server as IOServer } from 'socket.io';
import { makeEnvelope, WsType, type MediaKind, type Message } from '@den/shared';
import { chatRoom } from '../realtime/rooms.js';
import { QueueClosedError } from './jobQueue.js';
import { laneFor, mediaJobs } from './mediaJobs.js';
import { finalizeProcessing } from './service.js';

/** `media.ready` carries the whole message (docs/MEDIA_ATTACHMENTS.md §4.4),
 *  so every caller that changes a media row's status announces it this way. */
export function broadcastMediaReady(io: IOServer | undefined, message: Message): void {
  io?.to(chatRoom(message.chatId)).emit('ws', makeEnvelope(WsType.MediaReady, { message }));
}

/**
 * Queue processing for `mediaId` and broadcast `media.ready` when it lands.
 * Fire-and-forget: the uploader's request never waits on transcode time.
 * Returns false when nothing was started — a job for this id is already
 * queued/running, or the server is shutting down (the row then stays
 * 'processing' and the sweeper picks it up after the restart).
 */
export function startMediaProcessing(
  io: IOServer | undefined,
  log: FastifyBaseLogger,
  mediaId: bigint,
  kind: MediaKind,
): boolean {
  const job = mediaJobs.run(mediaId.toString(), laneFor(kind), () => finalizeProcessing(mediaId));
  if (!job) return false;
  job
    .then((message) => {
      // null = nothing changed, or the message isn't visible to anyone (soft-
      // deleted mid-transcode) — no frame to send.
      if (message) broadcastMediaReady(io, message);
    })
    .catch((err: unknown) => {
      if (err instanceof QueueClosedError) {
        log.warn({ mediaId: mediaId.toString() }, 'media processing not started before shutdown — left for the sweeper');
      } else {
        log.error({ err, mediaId: mediaId.toString() }, 'media processing failed');
      }
    });
  return true;
}

/** Graceful shutdown: stop accepting jobs, drop queued ones, wait up to
 *  `timeoutMs` for running ones. True if everything running finished. */
export function drainMediaJobs(timeoutMs: number): Promise<boolean> {
  return mediaJobs.drain(timeoutMs);
}
