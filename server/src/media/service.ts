/**
 * Media business logic (BACKBONE §5/§6/§7). Mirrors chat/service.ts's split:
 * DB access lives here; the routes/WS layer owns realtime side effects.
 *
 * Upload flow (§7):
 *   1. createUpload  — mints a `messages` row (kind=image|video|voice,
 *      body=null) + a `media` row (status='processing') in one transaction,
 *      then presigns a PUT for the client. The message row must exist first
 *      because `media.message_id` is NOT NULL (§5 DDL) — but nothing is
 *      broadcast over WS yet, so other members never see it mid-upload.
 *   2. Client PUTs bytes directly to R2 (never through this server).
 *   3. completeUpload — HEAD-verifies the object landed (never trust the
 *      client's claimed mime/size), optionally sets a caption, and returns
 *      the message with a 'processing' placeholder for the route to fan out.
 *   4. finalizeProcessing — runs the sharp/ffmpeg pipeline (media/process.ts)
 *      and flips the row to 'ready' (or 'failed'); the route fans out
 *      `media.ready` afterward.
 */
import { eq, inArray } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import {
  ChatLimits,
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
 *  per-row for a page of ~50 messages is cheap. */
export async function mediaInfoForMessages(messageIds: bigint[]): Promise<Map<string, MediaInfo>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select(mediaOnlyShape)
    .from(media)
    .where(inArray(media.messageId, messageIds));

  const out = new Map<string, MediaInfo>();
  await Promise.all(
    rows.map(async (row) => {
      const urls =
        row.status === 'ready'
          ? { url: await presignGet(row.r2Key), thumbUrl: row.thumbKey ? await presignGet(row.thumbKey) : null }
          : null;
      out.set(row.messageId.toString(), toMediaInfo(row, urls));
    }),
  );
  return out;
}

export interface CreateUploadResult {
  mediaId: bigint;
  presignedPutUrl: string;
}

export async function createUpload(
  chatId: bigint,
  uploaderId: bigint,
  kind: MediaKind,
  mime: string,
  sizeBytes: number,
): Promise<CreateUploadResult> {
  if (!mime.trim()) throw validation('mime is required');
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) throw validation('sizeBytes must be positive');
  if (sizeBytes > maxBytesFor(kind)) {
    throw validation(`${kind} uploads are limited to ${Math.floor(maxBytesFor(kind) / (1024 * 1024))}MB`);
  }

  const mediaId = await db.transaction(async (tx) => {
    const msgInserted = await tx.insert(messages).values({ chatId, senderId: uploaderId, kind, body: null }).returning();
    const messageRow = msgInserted[0]!;
    const mediaInserted = await tx
      .insert(media)
      .values({
        messageId: messageRow.id,
        uploaderId,
        kind,
        r2Key: '', // filled in below once the media id (part of the key) exists
        mime,
        sizeBytes: BigInt(sizeBytes),
        status: 'processing',
      })
      .returning();
    const mediaRow = mediaInserted[0]!;
    const key = mediaKey(chatId, mediaRow.id, 'orig');
    await tx.update(media).set({ r2Key: key }).where(eq(media.id, mediaRow.id));
    return mediaRow.id;
  });

  const key = mediaKey(chatId, mediaId, 'orig');
  const presignedPutUrl = await presignPut(key, mime);
  return { mediaId, presignedPutUrl };
}

export interface CompleteUploadResult {
  message: MessageDto;
  chatId: bigint;
  mediaId: bigint;
  mediaKind: MediaKind;
}

/** Verifies the object landed, applies an optional caption, and returns the
 *  message with a 'processing' media placeholder. Does not run the
 *  sharp/ffmpeg pipeline itself — call finalizeProcessing after fanning out
 *  the placeholder so members see it immediately (§7 step 4/5).
 *
 *  `replyToId` (post-MVP): the message row is created up front in
 *  `createUpload` (before the client PUTs bytes), so a reply can only be
 *  attached here, at complete-time, once the client actually has one to set
 *  (CompleteUploadRequest.replyToId) — set via an UPDATE after validating it
 *  references a non-deleted message in the same chat. */
export async function completeUpload(
  mediaId: bigint,
  userId: bigint,
  caption: string | undefined,
  replyToId?: bigint,
): Promise<CompleteUploadResult> {
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

  if (caption?.trim()) {
    const trimmed = caption.trim().slice(0, ChatLimits.messageBodyMax);
    await db.update(messages).set({ body: trimmed }).where(eq(messages.id, row.messageId));
  }

  if (replyToId !== undefined) {
    await assertReplyTarget(row.chatId, replyToId);
    await db.update(messages).set({ replyToMessageId: replyToId }).where(eq(messages.id, row.messageId));
  }

  const messageRow = await messageById(row.messageId);
  const mediaInfo = toMediaInfo(row, null); // still 'processing' — no URLs yet
  const replyTo = await replyPreviewFor(messageRow.replyToMessageId);
  return {
    message: toMessage(messageRow, mediaInfo, replyTo, []), // brand-new message: no reactions yet
    chatId: row.chatId,
    mediaId: row.id,
    mediaKind: row.kind as MediaKind,
  };
}

async function messageById(id: bigint): Promise<MessageRow> {
  const rows = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  return row;
}

/** Runs the processing pipeline and flips the row to ready/failed. Returns
 *  the updated message DTO (with fresh presigned URLs) for the caller to
 *  broadcast as `media.ready`. */
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

  const updated = await mediaRowById(mediaId);
  const messageRow = await messageById(row.messageId);
  if (!updated) throw notFound('media not found');

  const urls =
    updated.status === 'ready'
      ? { url: await presignGet(updated.r2Key), thumbUrl: updated.thumbKey ? await presignGet(updated.thumbKey) : null }
      : null;

  // Room broadcast, not per-viewer — there's no single "viewer" for `mine`
  // here, so it resolves as false for everyone; each client's own
  // reaction.added/removed frames (ws.ts) keep `mine` accurate afterward.
  // A reaction landing during the processing window is a rare race, not a
  // reason to skip resolving replyTo for every media.ready frame.
  const [replyTo, reactionsMap] = await Promise.all([
    replyPreviewFor(messageRow.replyToMessageId),
    reactionsForMessages([messageRow.id], 0n),
  ]);
  return toMessage(messageRow, toMediaInfo(updated, urls), replyTo, reactionsMap.get(messageRow.id.toString()) ?? []);
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
