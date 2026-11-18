/**
 * Media sweeper (audit fix 2026-11-18). Processing runs in-process with no
 * persisted job state, so a restart mid-transcode used to leave a row
 * 'processing' forever, and an upload abandoned after mint left a message +
 * R2 objects nobody would ever clean up. This runs shortly after boot and
 * then on an interval, and does two things:
 *
 *  (a) **Recover stuck items.** Media still 'processing' well after mint,
 *      not queued/running in this process, on a PUBLISHED message. Nothing
 *      in flight after a restart means the job died with the old process.
 *      What happens next depends on `media.completed_at` (migration 019),
 *      the durable marker completeUpload writes once the upload is verified
 *      AND its tags are attached:
 *       - set → complete ran, the job was lost. The original is re-verified
 *         (a client can re-PUT to a still-valid URL) and re-queued through
 *         the same "process, then broadcast" path the route uses; an object
 *         that's gone or fails verification is marked 'failed' and broadcast.
 *       - null → complete never got that far (e.g. an album item whose
 *         complete call failed and was never retried). It is NEVER
 *         auto-processed: doing so would publish it without the tags its
 *         complete would have carried (D7 — an `nsfw` item shown unblurred).
 *         Once old enough that it can't still be uploading, it is marked
 *         'failed' and broadcast. Rows from before migration 019 have a null
 *         marker too, so historic stuck rows fail rather than get published
 *         untagged — the intended, conservative outcome.
 *
 *  (b) **Discard abandoned uploads.** Messages still `pending_upload` an hour
 *      after mint: no item ever completed, so no member has ever seen them.
 *      The message is soft-deleted (never a hard delete — CLAUDE.md #8), its
 *      media marked 'failed', and the never-published source objects removed
 *      from R2 by `deleteAbandonedUploadObjects`.
 *
 * Both scans are served by the partial indexes added in migration 019
 * (`idx_media_processing_created`, `idx_messages_pending_created`), which only
 * ever hold the handful of rows currently mid-upload or mid-processing.
 *
 * Not done here, deliberately: (a)'s never-completed rows are marked failed
 * but their original objects are left in R2. Deleting bytes is limited to (b)
 * (never-published messages); widening it is the owner's call.
 */
import { and, asc, eq, exists, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Server as IOServer } from 'socket.io';
import type { MediaKind } from '@den/shared';
import { db } from '../db/index.js';
import { media, messages } from '../db/schema.js';
import { isMediaJobInFlight } from './mediaJobs.js';
import { broadcastMediaReady, startMediaProcessing } from './pipeline.js';
import { deleteObject } from './r2.js';
import { markMediaFailed, messageForBroadcast, verifyStoredUpload } from './service.js';

/** First sweep: soon after boot (recovering a restart is the main job), but
 *  not during it — let the server settle and clients reconnect first. */
const FIRST_SWEEP_DELAY_MS = 60_000;
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** (a) A 'processing' item older than this, with no job in this process, is
 *  considered stuck. Comfortably past the PUT URL TTL (10 min) plus a normal
 *  upload, so a complete still on its way usually gets there first — and if
 *  it races the sweeper anyway, the job queue's one-job-per-id rule means
 *  only one of them starts processing. */
const STUCK_PROCESSING_AFTER_MS = 15 * 60_000;
/** (a) …but a NEVER-COMPLETED item (`completed_at` null) is only declared
 *  failed after this long: an album item minted with its siblings may
 *  legitimately still be uploading, and then completing, long after the
 *  first item published the message (serial PUTs of up to 500MB each from a
 *  phone). */
const NEVER_COMPLETED_FAIL_AFTER_MS = 2 * 60 * 60_000;
/** (b) A message still pending this long after mint is abandoned. */
const ABANDONED_PENDING_AFTER_MS = 60 * 60_000;

const SWEEP_BATCH = 200;

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;
let current: Promise<void> | null = null;
let stopped = true;

export function startMediaSweeper(io: IOServer | undefined, log: FastifyBaseLogger): void {
  stopped = false;
  const tick = () => {
    if (stopped || current) return; // never overlap two sweeps
    current = sweepMediaOnce(io, log)
      .catch((err: unknown) => log.error({ err }, 'media sweep failed'))
      .finally(() => {
        current = null;
      });
  };
  firstTimer = setTimeout(() => {
    tick();
    intervalTimer = setInterval(tick, SWEEP_INTERVAL_MS);
    intervalTimer.unref();
  }, FIRST_SWEEP_DELAY_MS);
  firstTimer.unref();
}

/** Stops future sweeps and resolves once an in-progress one has finished
 *  (each loop checks `stopped` between items, so that's quick). */
export async function stopMediaSweeper(): Promise<void> {
  stopped = true;
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstTimer = intervalTimer = null;
  await current;
}

export async function sweepMediaOnce(io: IOServer | undefined, log: FastifyBaseLogger): Promise<void> {
  await recoverStuckProcessing(io, log);
  await discardAbandonedUploads(log);
}

// ─── (a) stuck 'processing' items on published messages ────────────────────

async function recoverStuckProcessing(io: IOServer | undefined, log: FastifyBaseLogger): Promise<void> {
  const now = Date.now();
  const neverCompletedCutoff = new Date(now - NEVER_COMPLETED_FAIL_AFTER_MS);
  const rows = await db
    .select({
      id: media.id,
      kind: media.kind,
      r2Key: media.r2Key,
      createdAt: media.createdAt,
      completedAt: media.completedAt,
      messageId: media.messageId,
      messageDeletedAt: messages.deletedAt,
    })
    .from(media)
    .innerJoin(messages, eq(messages.id, media.messageId))
    .where(
      and(
        eq(media.status, 'processing'),
        lt(media.createdAt, new Date(now - STUCK_PROCESSING_AFTER_MS)),
        eq(messages.pendingUpload, false),
      ),
    )
    .orderBy(asc(media.id))
    .limit(SWEEP_BATCH);

  for (const row of rows) {
    if (stopped) return;
    if (isMediaJobInFlight(row.id)) continue; // queued or running right now — not stuck
    const mediaId = row.id.toString();

    // Soft-deleted while its job was lost: nobody can see it, so there's no
    // frame to send — but leave it 'failed' rather than a forever-placeholder
    // in case the sender undoes the delete.
    if (row.messageDeletedAt !== null) {
      if (await markMediaFailed(row.id)) log.info({ mediaId }, 'sweeper: stuck media on a deleted message marked failed');
      continue;
    }

    if (row.completedAt === null) {
      // Complete never ran (or ran before migration 019). Never processed
      // here — see the file header (D7). Fail it once it can't plausibly
      // still be on its way. `onlyIfNotCompleted` closes the race with a
      // late complete: if completeUpload stamped completed_at a moment ago,
      // this matches nothing and the item proceeds normally.
      if (row.createdAt > neverCompletedCutoff) continue;
      await failAndBroadcast(io, log, row.id, row.messageId, 'never completed', { onlyIfNotCompleted: true });
      continue;
    }

    // Complete ran; the job was lost. Re-verify, then re-queue.
    const verdict = await verifyStoredUpload(row.id, row.r2Key, row.kind as MediaKind);
    if (verdict.ok) {
      if (startMediaProcessing(io, log, row.id, row.kind as MediaKind)) {
        log.warn({ mediaId }, 'sweeper: re-queued media stuck in processing');
      }
      continue;
    }
    if (verdict.reason === 'unreachable') {
      log.warn({ mediaId }, 'sweeper: storage unreachable, will retry next sweep');
      continue;
    }
    // 'missing' here means the object existed at complete time and is gone
    // now (e.g. the job deleted the original, then the process died before
    // the row was updated) — there's nothing left to wait for.
    await failAndBroadcast(io, log, row.id, row.messageId, verdict.reason);
  }
}

async function failAndBroadcast(
  io: IOServer | undefined,
  log: FastifyBaseLogger,
  mediaId: bigint,
  messageId: bigint,
  reason: string,
  opts: { onlyIfNotCompleted?: boolean } = {},
): Promise<void> {
  if (!(await markMediaFailed(mediaId, opts))) return;
  log.warn({ mediaId: mediaId.toString(), reason }, 'sweeper: stuck media marked failed');
  const message = await messageForBroadcast(messageId);
  if (message) broadcastMediaReady(io, message);
}

// ─── (b) abandoned pending uploads ─────────────────────────────────────────

/**
 * ⚠️ The one place the sweeper deletes stored bytes — kept in a single
 * function so it's easy to review. Only ever called with the keys of media
 * that (1) belong to a message that was never published (`pending_upload`,
 * claimed by `discardAbandonedUploads` below), and (2) are still
 * 'processing', i.e. were never verified or processed — so these objects
 * were never visible to any member and nothing references them once the row
 * is 'failed'. DELETE of a key that was never PUT is a no-op success in S3/R2.
 *
 * Returns true only if every key was deleted, so the caller marks the row
 * failed only then; a partial failure is retried next sweep.
 */
async function deleteAbandonedUploadObjects(keys: string[], log: FastifyBaseLogger): Promise<boolean> {
  let allDeleted = true;
  for (const key of keys) {
    try {
      await deleteObject(key);
    } catch (err) {
      allDeleted = false;
      log.error({ err, key }, 'sweeper: could not delete abandoned upload object');
    }
  }
  return allDeleted;
}

async function discardAbandonedUploads(log: FastifyBaseLogger): Promise<void> {
  const candidates = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.pendingUpload, true),
        lt(messages.createdAt, new Date(Date.now() - ABANDONED_PENDING_AFTER_MS)),
        // Still has work to do. Without this a fully-swept message (all media
        // 'failed') would be re-selected forever.
        exists(
          db
            .select({ one: sql`1` })
            .from(media)
            .where(and(eq(media.messageId, messages.id), eq(media.status, 'processing'))),
        ),
      ),
    )
    .orderBy(asc(messages.id))
    .limit(SWEEP_BATCH);

  for (const { id } of candidates) {
    if (stopped) return;

    // Claim it: soft-delete while still pending. This is the mirror image of
    // completeUpload's publish (`… WHERE pending_upload AND deleted_at IS
    // NULL`); Postgres serializes the two UPDATEs on the row, so a complete
    // that lands at the same moment either publishes first (and this matches
    // nothing) or finds the message deleted and is refused. COALESCE keeps
    // the sender's own deleted_at if they already deleted it.
    const claimed = await db
      .update(messages)
      .set({ deletedAt: sql`COALESCE(${messages.deletedAt}, now())` })
      .where(and(eq(messages.id, id), eq(messages.pendingUpload, true)))
      .returning({ id: messages.id });
    if (claimed.length === 0) continue;

    const items = await db
      .select({ id: media.id, r2Key: media.r2Key, thumbKey: media.thumbKey })
      .from(media)
      .where(and(eq(media.messageId, id), eq(media.status, 'processing')));

    let discarded = 0;
    for (const item of items) {
      if (isMediaJobInFlight(item.id)) continue; // can't happen for a pending message; never delete bytes under a job
      const keys = [item.r2Key, item.thumbKey].filter((k): k is string => !!k);
      if (await deleteAbandonedUploadObjects(keys, log)) {
        if (await markMediaFailed(item.id)) discarded++;
      }
    }
    log.info({ messageId: id.toString(), discarded }, 'sweeper: discarded abandoned upload');
  }
}
