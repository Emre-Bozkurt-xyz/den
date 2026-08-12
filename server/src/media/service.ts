/**
 * Media business logic (BACKBONE §5/§6/§7; albums/captions/sensitivity per
 * docs/MEDIA_ATTACHMENTS.md §4.4). Mirrors chat/service.ts's split: DB access
 * lives here; the routes/WS layer owns realtime side effects.
 *
 * Upload flow (§7, extended by MEDIA_ATTACHMENTS §4.4):
 *   1. createUpload  — mints ONE `messages` row (kind = the first item's
 *      kind, body = caption) + N `media` rows (status='processing') in one
 *      transaction, then presigns a PUT per item. The message row must exist
 *      first because `media.message_id` is NOT NULL (§5 DDL) — but nothing is
 *      broadcast over WS yet, so other members never see it mid-upload.
 *   2. Client PUTs bytes directly to R2 (never through this server), one item
 *      at a time.
 *   3. completeUpload — HEAD-verifies the object landed (never trust the
 *      client's claimed mime/size), attaches any tags BEFORE fanout (D7),
 *      and returns the whole message (with a 'processing' placeholder for
 *      this item) for the route to fan out — `message.new` for the first
 *      item of the message to complete, `media.ready` for every later one.
 *   4. finalizeProcessing — runs the sharp/ffmpeg pipeline (media/process.ts)
 *      and flips the row to 'ready' (or 'failed'); the route fans out
 *      `media.ready` afterward.
 */
import { eq, inArray } from 'drizzle-orm';
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
import { toMediaInfo, toMessage, type MediaRow, type MessageRow } from '../mappers.js';
import { notFound, validation } from '../errors.js';
import { getObjectHead, headObject, mediaKey, maxBytesFor, presignGet, presignPut } from './r2.js';
import { processMedia } from './process.js';
import { reactionsForMessages } from '../chat/reactions.js';
import { assertReplyTarget, replyPreviewFor } from '../chat/replies.js';
import { addTag, tagsForMediaIds } from './tags.js';

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

async function mediaRowById(mediaId: bigint): Promise<MediaJoinRow | null> {
  const rows = await db
    .select({ ...mediaOnlyShape, chatId: messages.chatId })
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
      .values({ chatId, senderId: uploaderId, kind: firstKind, body: trimmedCaption, replyToMessageId: replyToId ?? null })
      .returning();
    const messageRow = msgInserted[0]!;

    const ids: bigint[] = [];
    for (const item of items) {
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

// ─── per-item complete + album fanout race (docs/MEDIA_ATTACHMENTS.md §4.4) ─

/**
 * Which item "wins" `message.new` for a message with 2+ media (all others
 * ride `media.ready`, whose payload already carries the whole `Message` — see
 * docs/MEDIA_ATTACHMENTS.md §4.4). "First" can't be read off `media.status`
 * alone: every item sits at 'processing' from mint until ITS OWN
 * finalizeProcessing flips it to ready/failed, so two siblings racing through
 * completeUpload while both are still 'processing' look identical by status.
 *
 * There's no room to add a persisted "verified" state to close that gap:
 * `media_status_check` only allows processing/ready/failed, and widening it
 * is a migration — out of scope here, and db/schema.ts is owned by a
 * different change landing in parallel this session. Instead:
 *
 *  - If a sibling media row has ALREADY left 'processing' (ready/failed),
 *    this call is definitely not first — that's a real DB fact, checked
 *    every time, and is what makes a post-restart completeUpload call (see
 *    below) resolve correctly.
 *  - Otherwise, a process-local claim breaks the tie. Den runs a single API
 *    process (deploy/docker-compose.yml has exactly one `api` service), so
 *    this is airtight for the actual deployment: the check-then-set below has
 *    no `await` in it, so it can never interleave with another call's
 *    check-then-set, and whichever call reaches it first wins.
 *
 * The one gap this doesn't close: a process restart between "item A claimed
 * first" and "item A's media row leaves 'processing'" would let a later
 * caller re-claim first for the same message (in-memory claims don't survive
 * a restart). Accepted — it needs an actual mid-album-upload restart to hit,
 * and the failure mode is a harmless duplicate `message.new` for a message
 * that already exists, not data loss.
 */
const firstCompleteClaimed = new Set<string>();

async function claimFirstComplete(messageId: bigint, mediaId: bigint): Promise<boolean> {
  const siblings = await db.select({ id: media.id, status: media.status }).from(media).where(eq(media.messageId, messageId));
  const aSiblingAlreadyFinished = siblings.some((s) => s.id !== mediaId && s.status !== 'processing');
  if (aSiblingAlreadyFinished) return false;

  const key = messageId.toString();
  if (firstCompleteClaimed.has(key)) return false; // no `await` since the check above — atomic w.r.t. other calls
  firstCompleteClaimed.add(key);
  return true;
}

/** Drops the claim-bookkeeping for a message once every one of its media
 *  items has left 'processing' — after that point `claimFirstComplete`'s DB
 *  check alone is authoritative for any further (e.g. retried) call, so
 *  there's nothing left for the in-memory claim to protect. Keeps the Set
 *  from growing unboundedly over the server's lifetime. */
async function pruneFirstCompleteClaimIfDone(messageId: bigint): Promise<void> {
  const siblings = await db.select({ status: media.status }).from(media).where(eq(media.messageId, messageId));
  if (siblings.length > 0 && siblings.every((s) => s.status !== 'processing')) {
    firstCompleteClaimed.delete(messageId.toString());
  }
}

export interface CompleteUploadResult {
  message: MessageDto;
  chatId: bigint;
  mediaId: bigint;
  mediaKind: MediaKind;
  /** True iff the route should fan out `message.new` for this completion;
   *  false means `media.ready` (see the claimFirstComplete doc comment). */
  isFirstComplete: boolean;
}

/** Verifies the object landed, attaches any tags, and returns the whole
 *  message (every sibling media item included) for the route to fan out.
 *  Does not run the sharp/ffmpeg pipeline itself — call finalizeProcessing
 *  after fanning out the placeholder so members see it immediately (§7).
 *
 *  Tags are attached BEFORE the fanout decision below — this ordering is
 *  load-bearing and NOT an optimization target (docs/MEDIA_ATTACHMENTS.md
 *  D7): tagging over separate calls after the message went out would show
 *  every other member an unblurred `nsfw` image for a few hundred ms, which
 *  is the one thing this feature exists to prevent. Do not reorder this to
 *  "attach tags after fanout, it's faster" — it isn't a valid trade. */
export async function completeUpload(mediaId: bigint, userId: bigint, tags: string[] | undefined): Promise<CompleteUploadResult> {
  const row = await mediaRowById(mediaId);
  if (!row) throw notFound('media not found');
  if (row.uploaderId !== userId) throw notFound('media not found'); // don't leak existence to non-uploaders

  if (row.status !== 'processing') {
    // Idempotent: a retried complete-call just returns current state.
  } else {
    const head = await headObject(row.r2Key).catch((err: unknown) => {
      // Swallowed into a generic client-facing message by design (don't leak
      // storage internals), but log the real cause — a misconfigured R2
      // endpoint looks identical to "client never PUT the bytes" otherwise.
      console.error(`HEAD failed for media ${mediaId} (key ${row.r2Key}):`, err instanceof Error ? err.message : err);
      throw validation('upload not found in storage — retry the PUT');
    });
    if (head.sizeBytes <= 0 || head.sizeBytes > maxBytesFor(row.kind as MediaKind)) {
      throw validation('uploaded object size is invalid');
    }

    const sniffed = await getObjectHead(row.r2Key)
      .then((buf) => fileTypeFromBuffer(buf))
      .catch(() => undefined);
    if (sniffed) {
      const family = familyOf(sniffed.mime);
      if (family && !EXPECTED_FAMILY[row.kind as MediaKind].includes(family)) {
        throw validation(`uploaded file doesn't look like a ${row.kind} (detected ${sniffed.mime})`);
      }
    }
  }

  // D7: tags attach here, before the fanout decision below — see this
  // function's doc comment. addTag is idempotent (onConflictDoNothing), so
  // re-attaching on a retried complete-call is harmless.
  if (tags && tags.length > 0) {
    for (const name of tags) {
      await addTag(row.chatId, mediaId, userId, name);
    }
  }

  const isFirstComplete = await claimFirstComplete(row.messageId, row.id);

  const messageRow = await messageById(row.messageId);
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
  };
}

async function messageById(id: bigint): Promise<MessageRow> {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  return row;
}

/** Runs the processing pipeline and flips the row to ready/failed. Returns
 *  the updated message DTO (with every sibling media item, fresh presigned
 *  URLs included) for the caller to broadcast as `media.ready`. */
export async function finalizeProcessing(mediaId: bigint): Promise<MessageDto> {
  const row = await mediaRowById(mediaId);
  if (!row) throw notFound('media not found');

  try {
    const result = await processMedia({ chatId: row.chatId, mediaId: row.id, kind: row.kind as MediaKind, originalKey: row.r2Key });
    await db
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
      .where(eq(media.id, mediaId));
  } catch (err) {
    // Swallowed by design — a bad file (or a missing ffmpeg on a dev box)
    // must not crash the request that triggered it. Still worth a server log
    // line so a real failure on the VPS is diagnosable.
    console.error(`media processing failed for media ${mediaId}:`, err instanceof Error ? err.message : err);
    await db.update(media).set({ status: 'failed' }).where(eq(media.id, mediaId));
  }

  const messageRow = await messageById(row.messageId);

  // Room broadcast, not per-viewer — there's no single "viewer" for `mine`
  // here, so it resolves as false for everyone; each client's own
  // reaction.added/removed frames (ws.ts) keep `mine` accurate afterward.
  // A reaction landing during the processing window is a rare race, not a
  // reason to skip resolving replyTo for every media.ready frame.
  const [replyTo, reactionsMap, mediaMap] = await Promise.all([
    replyPreviewFor(messageRow.replyToMessageId),
    reactionsForMessages([messageRow.id], 0n),
    mediaInfoForMessages([row.messageId]),
  ]);
  void pruneFirstCompleteClaimIfDone(row.messageId);
  return toMessage(
    messageRow,
    mediaMap.get(row.messageId.toString()) ?? [],
    replyTo,
    reactionsMap.get(messageRow.id.toString()) ?? [],
  );
}

/** Caller must assertMember on the chat before calling this (chatIdForMedia
 *  below gives the route what it needs to do that check). */
export async function getMediaUrls(mediaId: bigint): Promise<{ url: string; thumbUrl: string | null }> {
  const row = await mediaRowById(mediaId);
  if (!row) throw notFound('media not found');
  if (row.status !== 'ready') throw validation('media is not ready yet');
  return { url: await presignGet(row.r2Key), thumbUrl: row.thumbKey ? await presignGet(row.thumbKey) : null };
}

/** Chat id a media row belongs to — routes assert membership against this
 *  before doing anything else (CLAUDE.md hard invariant 1). */
export async function chatIdForMedia(mediaId: bigint): Promise<bigint | null> {
  const rows = await db
    .select({ chatId: messages.chatId })
    .from(media)
    .innerJoin(messages, eq(messages.id, media.messageId))
    .where(eq(media.id, mediaId))
    .limit(1);
  return rows[0]?.chatId ?? null;
}
