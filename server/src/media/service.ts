/**
 * Media business logic (BACKBONE §5/§6/§7; albums/captions/sensitivity per
 * docs/MEDIA_ATTACHMENTS.md §4.4). Mirrors chat/service.ts's split: DB access
 * lives here; the routes/WS layer owns realtime side effects.
 *
 * Upload flow (§7, extended by MEDIA_ATTACHMENTS §4.4):
 *   1. createUpload  — mints ONE `messages` row (kind = the first item's
 *      kind, body = caption, `pending_upload = true`) + N `media` rows
 *      (status='processing') in one transaction, then presigns a PUT per
 *      item. The message row must exist first because `media.message_id` is
 *      NOT NULL (§5 DDL) — but it is pending: every message read path filters
 *      `pending_upload = false` and nothing is broadcast, so other members
 *      never see it mid-upload, and an abandoned upload never becomes a ghost
 *      "processing" bubble (the sweeper soft-deletes it after an hour).
 *   2. Client PUTs bytes directly to R2 (never through this server), one item
 *      at a time.
 *   3. completeUpload — HEAD-verifies the object landed (never trust the
 *      client's claimed mime/size; a rejected object is deleted), attaches
 *      any tags BEFORE fanout (D7), publishes the message if this is the
 *      first item to complete, and returns the whole message (with a
 *      'processing' placeholder for this item) for the route to fan out —
 *      `message.new` for the first item, `media.ready` for every later one.
 *   4. finalizeProcessing — runs the sharp/ffmpeg pipeline (media/process.ts)
 *      and flips the row to 'ready' (or 'failed'). Never called directly:
 *      pipeline.ts `startMediaProcessing` queues it (one job per id, bounded
 *      concurrency) and fans out `media.ready` afterward.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import {
  ChatLimits,
  MediaLimits,
  sensitivityOf,
  type MediaInfo,
  type MediaKind,
  type Message as MessageDto,
} from '@den/shared';
import { db } from '../db/index.js';
import { media, messages } from '../db/schema.js';
import { toMediaInfo, toMessage, type MediaRow } from '../mappers.js';
import { notFound, validation } from '../errors.js';
import { deleteObject, getObjectHead, headObject, isNotFoundError, mediaKey, maxBytesFor, presignGet, presignPut } from './r2.js';
import { processMedia, type ProcessResult } from './process.js';
import { isMediaJobInFlight } from './mediaJobs.js';
import { reactionsForMessages } from '../chat/reactions.js';
import { assertReplyTarget, replyPreviewFor } from '../chat/replies.js';
import { addTag, tagsForMediaIds } from './tags.js';
import { aspectHint } from '../aspectHint.js';

/** Containers MediaRecorder emits (webm, mp4) don't always let magic-number
 *  sniffing distinguish "video with no video track" from "actual video" —
 *  accept either family for voice so a real recording never gets rejected.
 *  Sniffing here is defense-in-depth against a clearly mislabeled upload
 *  (CLAUDE.md #7), not a strict allowlist: an undetected format doesn't block. */
const EXPECTED_FAMILY: Record<MediaKind, Array<'image' | 'video' | 'audio'>> = {
  image: ['image'],
  video: ['video'],
  voice: ['audio', 'video'],
};

function familyOf(mime: string): 'image' | 'video' | 'audio' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

interface MediaJoinRow extends MediaRow {
  messageId: bigint;
  chatId: bigint;
  uploaderId: bigint;
  r2Key: string;
  thumbKey: string | null;
  messageDeletedAt: Date | null;
}

const mediaOnlyShape = {
  id: media.id,
  messageId: media.messageId,
  uploaderId: media.uploaderId,
  kind: media.kind,
  r2Key: media.r2Key,
  mime: media.mime,
  sizeBytes: media.sizeBytes,
  width: media.width,
  height: media.height,
  durationMs: media.durationMs,
  waveform: media.waveform,
  thumbKey: media.thumbKey,
  status: media.status,
} as const;

/** ⚠️ Deliberately does NOT filter soft-deleted messages — it's the internal
 *  lookup, and processing must be able to finish for a message deleted
 *  mid-transcode (so an undo-restore shows the finished media, not a
 *  placeholder forever). Every externally reachable path checks
 *  `messageDeletedAt` itself (CLAUDE.md #8): completeUpload, getMediaUrls,
 *  and chatIdForMedia, which gates the remaining /media/:id routes. */
async function mediaRowById(mediaId: bigint): Promise<MediaJoinRow | null> {
  const rows = await db
    .select({ ...mediaOnlyShape, chatId: messages.chatId, messageDeletedAt: messages.deletedAt })
    .from(media)
    .innerJoin(messages, eq(messages.id, media.messageId))
    .where(eq(media.id, mediaId))
    .limit(1);
  return rows[0] ?? null;
}

/** Batch-fetch + presign media for a page of messages (chat/service.ts).
 *  Presigning is a local HMAC computation, not a network call, so doing it
 *  per-row for a page of ~50 messages is cheap.
 *
 *  Returns EVERY media row per message (docs/MEDIA_ATTACHMENTS.md §4.1: an
 *  album is N media rows on one message), ordered by media id ASC — the
 *  contract `Message.media`'s doc comment promises. `Promise.all` resolves
 *  its results in the same order as the input array regardless of which
 *  presign call finishes first, so building `infos` first and only THEN
 *  grouping by message id (rather than pushing into the map from inside the
 *  async callback) is what keeps that ordering intact. */
export async function mediaInfoForMessages(messageIds: bigint[]): Promise<Map<string, MediaInfo[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select(mediaOnlyShape)
    .from(media)
    .where(inArray(media.messageId, messageIds))
    .orderBy(media.id);

  const tagMap = await tagsForMediaIds(rows.map((r) => r.id));

  const infos = await Promise.all(
    rows.map(async (row) => {
      const urls =
        row.status === 'ready'
          ? { url: await presignGet(row.r2Key), thumbUrl: row.thumbKey ? await presignGet(row.thumbKey) : null }
          : null;
      const tagNames = (tagMap.get(row.id.toString()) ?? []).map((t) => t.name);
      return { messageId: row.messageId, info: toMediaInfo(row, urls, sensitivityOf(tagNames)) };
    }),
  );

  const out = new Map<string, MediaInfo[]>();
  for (const { messageId, info } of infos) {
    const list = out.get(messageId.toString()) ?? [];
    list.push(info);
    out.set(messageId.toString(), list);
  }
  return out;
}

// ─── album mint (docs/MEDIA_ATTACHMENTS.md §4.4) ────────────────────────────

export interface CreateUploadItemInput {
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
  /** Client-declared aspect hint (docs/MEDIA_ATTACHMENTS.md §4.6) — clamped
   *  through `aspectHint()` below, overwritten by real measurements at
   *  processing time. */
  width?: number;
  height?: number;
}

export interface CreateUploadItemResult {
  mediaId: bigint;
  presignedPutUrl: string;
}

export interface CreateUploadResult {
  messageId: bigint;
  items: CreateUploadItemResult[];
}

/** POST /media/uploads. Mints ONE message row + N media rows (one per item)
 *  in a single transaction, then returns a presigned PUT per item, same
 *  order as `items`. All-or-nothing: every item is validated BEFORE the
 *  transaction opens, so a bad item anywhere in the batch means nothing is
 *  written — never a partial mint. `caption`/`replyToId` belong to the
 *  message (D2: an album is one message), so they're validated and applied
 *  here rather than at complete-time. */
export async function createUpload(
  chatId: bigint,
  uploaderId: bigint,
  items: CreateUploadItemInput[],
  caption: string | undefined,
  replyToId: bigint | undefined,
): Promise<CreateUploadResult> {
  if (items.length === 0) throw validation('at least one item is required');
  if (items.length > MediaLimits.maxAttachments) {
    throw validation(`albums are limited to ${MediaLimits.maxAttachments} items`);
  }
  for (const item of items) {
    if (!item.mime || !item.mime.trim()) throw validation('mime is required for every item');
    if (!Number.isFinite(item.sizeBytes) || item.sizeBytes <= 0) {
      throw validation('sizeBytes must be positive for every item');
    }
    if (item.sizeBytes > maxBytesFor(item.kind)) {
      throw validation(`${item.kind} uploads are limited to ${Math.floor(maxBytesFor(item.kind) / (1024 * 1024))}MB`);
    }
  }

  let trimmedCaption: string | null = null;
  if (caption?.trim()) {
    trimmedCaption = caption.trim();
    if (trimmedCaption.length > ChatLimits.messageBodyMax) {
      throw validation(`message too long (max ${ChatLimits.messageBodyMax} characters)`);
    }
  }
  if (replyToId !== undefined) await assertReplyTarget(chatId, replyToId);

  const firstKind = items[0]!.kind;

  const { messageId, mediaIds } = await db.transaction(async (tx) => {
    const msgInserted = await tx
      .insert(messages)
      // pendingUpload: invisible to every read path until completeUpload
      // publishes it (see the file header and completeUpload).
      .values({ chatId, senderId: uploaderId, kind: firstKind, body: trimmedCaption, replyToMessageId: replyToId ?? null, pendingUpload: true })
      .returning();
    const messageRow = msgInserted[0]!;

    const ids: bigint[] = [];
    for (const item of items) {
      // docs/MEDIA_ATTACHMENTS.md §4.6 — a provisional aspect so other
      // members' 'processing' placeholder is the right shape immediately.
      // Voice has no visual box, so it never carries one. Overwritten by
      // process.ts's measured dims (sharp/ffprobe, EXIF-orientation aware) on
      // success; on failure the row is never rendered by any read path.
      const hint = item.kind === 'voice' ? undefined : aspectHint(item.width, item.height);
      const mediaInserted = await tx
        .insert(media)
        .values({
          messageId: messageRow.id,
          uploaderId,
          kind: item.kind,
          r2Key: '', // filled in below once the media id (part of the key) exists
          mime: item.mime,
          sizeBytes: BigInt(item.sizeBytes),
          status: 'processing',
          ...(hint ? { width: hint.width, height: hint.height } : {}),
        })
        .returning();
      const mediaRow = mediaInserted[0]!;
      const key = mediaKey(chatId, mediaRow.id, 'orig');
      await tx.update(media).set({ r2Key: key }).where(eq(media.id, mediaRow.id));
      ids.push(mediaRow.id);
    }
    return { messageId: messageRow.id, mediaIds: ids };
  });

  const resultItems: CreateUploadItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const mediaId = mediaIds[i]!;
    const key = mediaKey(chatId, mediaId, 'orig');
    const presignedPutUrl = await presignPut(key, items[i]!.mime);
    resultItems.push({ mediaId, presignedPutUrl });
  }

  return { messageId, items: resultItems };
}

// ─── upload verification (CLAUDE.md #7) ─────────────────────────────────────

export type VerifyOutcome =
  | { ok: true }
  /** `missing`: storage says there is no such object (never PUT, or already
   *  discarded). `unreachable`: storage couldn't be asked — retry later,
   *  never treat as missing. `rejected`: the object was there but failed the
   *  size/type checks, and has been deleted. */
  | { ok: false; reason: 'missing' | 'unreachable' | 'rejected'; message: string };

/** Removes an uploaded object that failed verification. Before the audit
 *  (2026-11-18) a rejected upload stayed in R2 forever — and since the PUT
 *  signature binds only the content type, not the length, "rejected for
 *  being oversized" was exactly the case that leaked the most storage.
 *  Best-effort: a failed delete is logged, the rejection still stands. */
async function discardRejectedUpload(mediaId: bigint, key: string): Promise<void> {
  await deleteObject(key).catch((err: unknown) => {
    console.error(`could not delete rejected upload for media ${mediaId} (key ${key}):`, err instanceof Error ? err.message : err);
  });
}

/** HEAD + magic-number sniff of an uploaded original (never trust the
 *  client's claimed mime/size). Shared by completeUpload and the sweeper
 *  (sweeper.ts), which re-verifies before re-queuing a stuck item: its
 *  complete ran (`completed_at` is set), but the object may have changed
 *  since — a client can re-PUT to a still-valid presigned URL. */
export async function verifyStoredUpload(mediaId: bigint, key: string, kind: MediaKind): Promise<VerifyOutcome> {
  let head: Awaited<ReturnType<typeof headObject>>;
  try {
    head = await headObject(key);
  } catch (err) {
    // Swallowed into a generic client-facing message by design (don't leak
    // storage internals), but log the real cause — a misconfigured R2
    // endpoint looks identical to "client never PUT the bytes" otherwise.
    console.error(`HEAD failed for media ${mediaId} (key ${key}):`, err instanceof Error ? err.message : err);
    return { ok: false, reason: isNotFoundError(err) ? 'missing' : 'unreachable', message: 'upload not found in storage — retry the PUT' };
  }
  if (head.sizeBytes <= 0 || head.sizeBytes > maxBytesFor(kind)) {
    await discardRejectedUpload(mediaId, key);
    return { ok: false, reason: 'rejected', message: 'uploaded object size is invalid' };
  }

  const sniffed = await getObjectHead(key)
    .then((buf) => fileTypeFromBuffer(buf))
    .catch(() => undefined);
  if (sniffed) {
    const family = familyOf(sniffed.mime);
    if (family && !EXPECTED_FAMILY[kind].includes(family)) {
      await discardRejectedUpload(mediaId, key);
      return { ok: false, reason: 'rejected', message: `uploaded file doesn't look like a ${kind} (detected ${sniffed.mime})` };
    }
  }
  return { ok: true };
}

// ─── per-item complete + album fanout race (docs/MEDIA_ATTACHMENTS.md §4.4) ─

/**
 * Which item "wins" `message.new` for a message with 2+ media (all others
 * ride `media.ready`, whose payload already carries the whole `Message` — see
 * docs/MEDIA_ATTACHMENTS.md §4.4).
 *
 * The answer is a database fact, not a process-local one (audit 2026-11-18,
 * migration 0018): the message is minted with `pending_upload = true`, and
 * completeUpload publishes it with
 *
 *     UPDATE messages SET pending_upload = false
 *      WHERE id = $1 AND pending_upload AND deleted_at IS NULL
 *     RETURNING id
 *
 * Postgres row-locks the message for the UPDATE, so two sibling completes
 * racing here serialize: the first flips the flag and gets its row back, the
 * second re-evaluates `pending_upload` against the committed row, matches
 * nothing, and gets zero rows. Whoever gets a row back is first — exactly
 * once per message, across restarts. That replaces the old in-memory
 * `firstCompleteClaimed` Set and closes the restart gap it documented.
 *
 * Cases the rule has to get right:
 *  - Retried complete of an item: the flag is already false → zero rows →
 *    `media.ready` (a duplicate `message.new` is never sent).
 *  - `deleted_at IS NULL` makes the publish atomic against the sweeper,
 *    which soft-deletes abandoned pending messages under the mirror-image
 *    condition (`WHERE pending_upload`). Whichever UPDATE lands first wins;
 *    an upload can never be published after the sweeper discarded its bytes.
 *  - Rows minted before migration 0018 have `pending_upload = false` from the
 *    column default, so every complete for them rides `media.ready` and none
 *    pushes. Those messages were already visible to read paths (that was the
 *    old ghost-bubble behaviour), and the deploy that introduces this restarts
 *    the server, so every client reconnects and refetches them (CLAUDE.md
 *    #3) — `media.ready` then patches them in place. The cost is one missing
 *    push for an album that was mid-upload during that deploy.
 */
async function publishIfPending(messageId: bigint): Promise<boolean> {
  const published = await db
    .update(messages)
    .set({ pendingUpload: false })
    .where(and(eq(messages.id, messageId), eq(messages.pendingUpload, true), isNull(messages.deletedAt)))
    .returning({ id: messages.id });
  return published.length > 0;
}

export interface CompleteUploadResult {
  message: MessageDto;
  chatId: bigint;
  mediaId: bigint;
  mediaKind: MediaKind;
  /** True iff the route should fan out `message.new` for this completion;
   *  false means `media.ready` (see the publishIfPending doc comment). */
  isFirstComplete: boolean;
  /** True iff THIS call verified a still-'processing' item that has no job
   *  queued or running — i.e. the caller should start processing. False for
   *  every retried complete of a ready/failed item, and for a retry that
   *  arrives while the job is already in flight: re-running the pipeline on
   *  an already-processed row is what used to destroy stored videos. */
  shouldProcess: boolean;
}

/** Verifies the object landed, attaches any tags, publishes the message if
 *  this is its first completed item, and returns the whole message (every
 *  sibling media item included) for the route to fan out. Does not run the
 *  sharp/ffmpeg pipeline itself — the route starts it after fanning out the
 *  placeholder so members see it immediately (§7).
 *
 *  Tags are attached BEFORE the publish/fanout below — this ordering is
 *  load-bearing and NOT an optimization target (docs/MEDIA_ATTACHMENTS.md
 *  D7): tagging over separate calls after the message went out would show
 *  every other member an unblurred `nsfw` image for a few hundred ms, which
 *  is the one thing this feature exists to prevent. Do not reorder this to
 *  "attach tags after fanout, it's faster" — it isn't a valid trade. */
export async function completeUpload(mediaId: bigint, userId: bigint, tags: string[] | undefined): Promise<CompleteUploadResult> {
  const row = await mediaRowById(mediaId);
  if (!row) throw notFound('media not found');
  if (row.uploaderId !== userId) throw notFound('media not found'); // don't leak existence to non-uploaders
  if (row.messageDeletedAt !== null) throw notFound('media not found'); // CLAUDE.md #8

  // Idempotent: a retried complete of a ready/failed item, or of one whose
  // job is already queued/running, just returns current state. Skipping the
  // re-verify for an in-flight item matters: the job deletes the original
  // once its replacement is uploaded, so a HEAD in that window would tell
  // the client to re-PUT bytes nothing will ever clean up.
  const shouldProcess = row.status === 'processing' && !isMediaJobInFlight(row.id);
  if (shouldProcess) {
    const verdict = await verifyStoredUpload(row.id, row.r2Key, row.kind as MediaKind);
    if (!verdict.ok) throw validation(verdict.message);
  }

  // D7: tags attach here, before the publish/fanout below — see this
  // function's doc comment. addTag is idempotent (onConflictDoNothing), so
  // re-attaching on a retried complete-call is harmless.
  if (tags && tags.length > 0) {
    for (const name of tags) {
      await addTag(row.chatId, mediaId, userId, name);
    }
  }

  // Durable "complete ran" marker (migration 019): verified AND tagged, so
  // this item is now safe to show. Written before publish/fanout so it can
  // never lag a visible message. The sweeper re-queues a stuck 'processing'
  // row only when this is set — without it, it can't tell "job lost to a
  // restart" from "complete never arrived", and processing the latter would
  // publish it without its tags. COALESCE keeps the first timestamp across
  // retries (a retry after a restart re-verifies but changes nothing here).
  if (shouldProcess) {
    await db
      .update(media)
      .set({ completedAt: sql`COALESCE(${media.completedAt}, now())` })
      .where(eq(media.id, row.id));
  }

  const isFirstComplete = await publishIfPending(row.messageId);

  const messageRow = await messageById(row.messageId);
  // Not published by us and not visible either: the message was soft-deleted
  // (by its sender, or by the sweeper as an abandoned upload) since the row
  // was read above. Nothing to fan out, nothing to process.
  if (messageRow.deletedAt !== null || messageRow.pendingUpload) throw notFound('media not found');

  const [replyTo, mediaMap] = await Promise.all([
    replyPreviewFor(messageRow.replyToMessageId),
    mediaInfoForMessages([row.messageId]),
  ]);
  return {
    message: toMessage(messageRow, mediaMap.get(row.messageId.toString()) ?? [], replyTo, []), // brand-new message: no reactions yet
    chatId: row.chatId,
    mediaId: row.id,
    mediaKind: row.kind as MediaKind,
    isFirstComplete,
    shouldProcess,
  };
}

/** The full row (not mappers.ts's `MessageRow` subset): callers here need
 *  `deletedAt`/`pendingUpload` to decide whether a message is visible. */
async function messageById(id: bigint): Promise<typeof messages.$inferSelect> {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  return row;
}

/** The full message DTO (every sibling media item, fresh presigned URLs) for
 *  a `media.ready` room broadcast — or null when the message isn't visible
 *  to anyone (soft-deleted, or still pending), in which case there is
 *  nothing to announce. An undo-restore of a deleted message returns fresh
 *  DTOs of its own (chat/service.ts restoreMessages). */
export async function messageForBroadcast(messageId: bigint): Promise<MessageDto | null> {
  const messageRow = await messageById(messageId);
  if (messageRow.deletedAt !== null || messageRow.pendingUpload) return null;

  // Room broadcast, not per-viewer — there's no single "viewer" for `mine`
  // here, so it resolves as false for everyone; each client's own
  // reaction.added/removed frames (ws.ts) keep `mine` accurate afterward.
  // A reaction landing during the processing window is a rare race, not a
  // reason to skip resolving replyTo for every media.ready frame.
  const [replyTo, reactionsMap, mediaMap] = await Promise.all([
    replyPreviewFor(messageRow.replyToMessageId),
    reactionsForMessages([messageRow.id], 0n),
    mediaInfoForMessages([messageId]),
  ]);
  return toMessage(
    messageRow,
    mediaMap.get(messageId.toString()) ?? [],
    replyTo,
    reactionsMap.get(messageRow.id.toString()) ?? [],
  );
}

/** processing → failed, and ONLY from processing: a late failure (or a
 *  sweeper verdict) must never downgrade a row that already reached 'ready'.
 *  True iff this call changed the row.
 *
 *  `onlyIfNotCompleted`: also require `completed_at IS NULL` — the sweeper's
 *  "complete never arrived" verdict, made conditional so a complete that
 *  stamps the row at the same moment wins instead of being failed. */
export async function markMediaFailed(mediaId: bigint, opts: { onlyIfNotCompleted?: boolean } = {}): Promise<boolean> {
  const conditions = [eq(media.id, mediaId), eq(media.status, 'processing')];
  if (opts.onlyIfNotCompleted) conditions.push(isNull(media.completedAt));
  const updated = await db
    .update(media)
    .set({ status: 'failed' })
    .where(and(...conditions))
    .returning({ id: media.id });
  return updated.length > 0;
}

/** Runs the processing pipeline and flips the row to ready/failed. Returns
 *  the updated message DTO for the caller to broadcast as `media.ready`, or
 *  null when there is nothing to announce.
 *
 *  ⚠️ Call only through pipeline.ts `startMediaProcessing` — the queue there
 *  is what guarantees one job per media id. The status checks below are the
 *  second layer: a row that is no longer 'processing' is never re-processed
 *  (process.ts deletes originals, so re-running it against a finished row is
 *  destructive), and both outcome writes are conditional on the row still
 *  being 'processing'. */
export async function finalizeProcessing(mediaId: bigint): Promise<MessageDto | null> {
  const row = await mediaRowById(mediaId);
  if (!row) throw notFound('media not found');
  if (row.status !== 'processing') return null;

  let result: ProcessResult;
  try {
    result = await processMedia({ chatId: row.chatId, mediaId: row.id, kind: row.kind as MediaKind, originalKey: row.r2Key });
  } catch (err) {
    // Swallowed by design — a bad file (or a missing ffmpeg on a dev box)
    // must not crash anything. Still worth a server log line so a real
    // failure on the VPS is diagnosable.
    console.error(`media processing failed for media ${mediaId}:`, err instanceof Error ? err.message : err);
    return (await markMediaFailed(mediaId)) ? messageForBroadcast(row.messageId) : null;
  }

  // A DB error here propagates (logged by the pipeline) and leaves the row
  // 'processing' for the sweeper, rather than being mislabelled a processing
  // failure.
  const updated = await db
    .update(media)
    .set({
      r2Key: result.r2Key,
      mime: result.mime,
      sizeBytes: BigInt(result.sizeBytes),
      width: result.width,
      height: result.height,
      durationMs: result.durationMs,
      waveform: result.waveform,
      thumbKey: result.thumbKey,
      status: 'ready',
    })
    .where(and(eq(media.id, mediaId), eq(media.status, 'processing')))
    .returning({ id: media.id });
  if (updated.length === 0) return null;

  return messageForBroadcast(row.messageId);
}

/** Caller must assertMember on the chat before calling this (chatIdForMedia
 *  below gives the route what it needs to do that check). */
export async function getMediaUrls(mediaId: bigint): Promise<{ url: string; thumbUrl: string | null }> {
  const row = await mediaRowById(mediaId);
  if (!row || row.messageDeletedAt !== null) throw notFound('media not found'); // CLAUDE.md #8
  if (row.status !== 'ready') throw validation('media is not ready yet');
  return { url: await presignGet(row.r2Key), thumbUrl: row.thumbKey ? await presignGet(row.thumbKey) : null };
}

/** Chat id a media row belongs to — routes assert membership against this
 *  before doing anything else (CLAUDE.md hard invariant 1).
 *
 *  Null for media whose message is soft-deleted (CLAUDE.md #8): every
 *  /media/:id route goes through here, so a deleted message's media can't be
 *  re-fetched, re-tagged or completed by id. Internal callers that must still
 *  see such rows (processing a message deleted mid-transcode) use
 *  mediaRowById instead. Pending (not yet published) messages are NOT
 *  filtered: /media/:id/complete is what publishes them. */
export async function chatIdForMedia(mediaId: bigint): Promise<bigint | null> {
  const rows = await db
    .select({ chatId: messages.chatId })
    .from(media)
    .innerJoin(messages, eq(messages.id, media.messageId))
    .where(and(eq(media.id, mediaId), isNull(messages.deletedAt)))
    .limit(1);
  return rows[0]?.chatId ?? null;
}
