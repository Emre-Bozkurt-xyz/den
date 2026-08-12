import {
  MediaLimits,
  type CompleteUploadRequest,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type MediaKind,
  type MediaUrlResponse,
  type Message,
} from '@den/shared';
import { api } from './api';

/** Best-effort kind from a picked file's mime — matches the three §7 kinds.
 *  Anything else (docs, etc.) isn't part of MVP scope. */
export function kindForMime(mime: string): MediaKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return null;
}

/**
 * A picked-but-not-yet-sent image/video (docs/MEDIA_ATTACHMENTS.md §5.1, D1).
 * Lives in `ChatView` state (per-chat caching across chat switches is wired
 * separately at integration) and is turned into an album on Send.
 *
 * `previewUrl` is an `URL.createObjectURL(file)` — the owner (`Composer`, the
 * only place that creates one) is responsible for revoking it on removal and
 * on unmount. `tags` is a plain client-side name list (including
 * `nsfw`/`spoiler` — see `@den/shared`'s `SENSITIVE_TAGS`) that rides along on
 * that item's `complete` call (D7): nothing is uploaded while attachments sit
 * staged or while the attachment sheet is open.
 *
 * `mediaId`/`presignedPutUrl`/`requiredContentType` are set once the album has
 * been minted at least once (first send attempt) — a failed PUT/complete
 * keeps them so a retry can re-PUT to the still-valid presigned URL (10 min
 * TTL) instead of re-minting the whole album.
 */
export interface StagedAttachment {
  localId: string;
  file: File;
  kind: 'image' | 'video';
  previewUrl: string | null;
  tags: string[];
  status: 'staged' | 'uploading' | 'done' | 'failed';
  /** 0–100, meaningful while `status === 'uploading'`. */
  progress: number;
  mediaId?: string;
  presignedPutUrl?: string;
  requiredContentType?: string;
}

/** Attach-time validation + `StagedAttachment` construction (docs
 *  §5.1: "validate at attach time, inline in the tray") — a pure helper
 *  shared by `Composer`'s tray (the normal attach/paste path) and
 *  `AttachmentSheet`'s own "+" tile, so the two never drift on what's
 *  accepted. Creates one `URL.createObjectURL` per accepted file; the caller
 *  owns revoking them (see `StagedAttachment`'s doc comment). */
export function stageFiles(
  picked: File[],
  currentCount: number,
): { accepted: StagedAttachment[]; error: string | null } {
  const room = Math.max(0, MediaLimits.maxAttachments - currentCount);
  const accepted: StagedAttachment[] = [];
  let skippedKind = 0;
  let skippedSize = 0;
  let skippedRoom = 0;

  for (const file of picked) {
    if (accepted.length >= room) {
      skippedRoom++;
      continue;
    }
    const kind = kindForMime(file.type);
    if (kind !== 'image' && kind !== 'video') {
      skippedKind++;
      continue;
    }
    if (file.size > MediaLimits.maxBytes[kind]) {
      skippedSize++;
      continue;
    }
    accepted.push({
      localId: crypto.randomUUID(),
      file,
      kind,
      previewUrl: URL.createObjectURL(file),
      tags: [],
      status: 'staged',
      progress: 0,
    });
  }

  const problems: string[] = [];
  if (skippedKind > 0) problems.push(`${skippedKind} skipped (pick an image or video)`);
  if (skippedSize > 0) problems.push(`${skippedSize} skipped (too large)`);
  if (skippedRoom > 0) problems.push(`${skippedRoom} skipped (up to ${MediaLimits.maxAttachments} attachments)`);
  return { accepted, error: problems.length > 0 ? problems.join('; ') : null };
}

/** Thrown by `putWithProgress` so callers can tell an expired/invalid
 *  presigned URL (403 — see `MediaLimits.putUrlTtlSeconds`) apart from a
 *  generic network failure, for the retry-vs-re-mint decision (docs §5.1's
 *  "expired URLs → re-mint as a new album and discard the old"). */
export class UploadHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Upload failed (${status})`);
    this.status = status;
  }
}

/** PUT straight to R2/MinIO with upload progress (XHR gives progress events;
 *  fetch's upload-stream API isn't there yet cross-browser). No credentials —
 *  the presigned URL's signature *is* the auth (hard invariant 2). */
function putWithProgress(url: string, body: Blob, contentType: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new UploadHttpError(xhr.status)));
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(body);
  });
}

export interface AlbumItemResult {
  localId: string;
  mediaId: string;
  presignedPutUrl: string;
  requiredContentType: string;
  ok: boolean;
  /** True when the PUT failed with a status that looks like an expired
   *  presigned URL — the caller should re-mint rather than keep retrying. */
  expired: boolean;
}

/** PUT then complete for one already-minted item — shared by the fresh mint
 *  path (`uploadAlbum`) and the retry-only path (`retryAlbumItems`), which
 *  both already have a `{mediaId, presignedPutUrl, requiredContentType}` to
 *  work from and only differ in *how* they got it. */
async function uploadOneItem(
  file: Blob,
  tags: string[],
  mint: { mediaId: string; presignedPutUrl: string; requiredContentType: string },
  index: number,
  total: number,
  onProgress?: (itemIndex: number, itemPct: number, total: number) => void,
): Promise<AlbumItemResult> {
  const base = { localId: mint.mediaId, mediaId: mint.mediaId, presignedPutUrl: mint.presignedPutUrl, requiredContentType: mint.requiredContentType };
  try {
    await putWithProgress(mint.presignedPutUrl, file, mint.requiredContentType, (pct) => onProgress?.(index, pct, total));
  } catch (e) {
    return { ...base, ok: false, expired: e instanceof UploadHttpError && (e.status === 403 || e.status === 400) };
  }
  try {
    const completeBody: CompleteUploadRequest = tags.length > 0 ? { tags } : {};
    await api<Message>(`/api/media/${mint.mediaId}/complete`, { method: 'POST', body: JSON.stringify(completeBody) });
    onProgress?.(index, 100, total);
    return { ...base, ok: true, expired: false };
  } catch {
    return { ...base, ok: false, expired: false };
  }
}

export interface AlbumUploadOutcome {
  messageId: string;
  items: AlbumItemResult[];
}

/**
 * Full album upload (docs/MEDIA_ATTACHMENTS.md §4.4, D1/D2): one mint call
 * carrying every item plus caption/replyToId, then serial PUTs — NOT
 * parallel, same reasoning as the pre-album implementation this replaces:
 * honest per-item progress, and phone radios/CPU shouldn't be hammered by N
 * concurrent PUTs — then a per-item `complete` carrying that item's tags
 * (attached before fanout, D7).
 *
 * `onProgress(itemIndex, itemPct, total)` lets the caller show "2 of 3 —
 * 47%". Returns per-item outcomes rather than throwing on a partial failure —
 * a failed item's `{mediaId, presignedPutUrl, requiredContentType}` is
 * included so the caller can retry just that item via `retryAlbumItems`
 * without re-minting (§5.1: "a failed send keeps the tray").
 */
export async function uploadAlbum(
  chatId: string,
  items: { localId: string; file: Blob; kind: MediaKind; mime: string; tags: string[] }[],
  caption: string | undefined,
  replyToId: string | undefined,
  onProgress?: (itemIndex: number, itemPct: number, total: number) => void,
): Promise<AlbumUploadOutcome> {
  const createBody: CreateUploadRequest = {
    chatId,
    items: items.map((i) => ({ kind: i.kind, mime: i.mime, sizeBytes: i.file.size })),
    ...(caption?.trim() ? { caption: caption.trim() } : {}),
    ...(replyToId ? { replyToId } : {}),
  };
  const created = await api<CreateUploadResponse>('/api/media/uploads', {
    method: 'POST',
    body: JSON.stringify(createBody),
  });

  const results: AlbumItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const input = items[i]!;
    const mint = created.items[i]!;
    const result = await uploadOneItem(input.file, input.tags, mint, i, items.length, onProgress);
    results.push({ ...result, localId: input.localId });
  }
  return { messageId: created.messageId, items: results };
}

/** Retries already-minted items (mint succeeded, PUT and/or complete didn't)
 *  by re-PUTting to their still-valid presigned URLs — no re-mint, so this
 *  stays scoped to the *same* album message. Callers should check
 *  `AlbumItemResult.expired` on a fresh failure and fall back to minting a
 *  brand-new album (`uploadAlbum`) + discarding the orphaned old message
 *  (docs §5.1: "expired URLs → re-mint as a new album and discard the old"). */
export async function retryAlbumItems(
  items: { localId: string; file: Blob; tags: string[]; mediaId: string; presignedPutUrl: string; requiredContentType: string }[],
  onProgress?: (itemIndex: number, itemPct: number, total: number) => void,
): Promise<AlbumItemResult[]> {
  const results: AlbumItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const input = items[i]!;
    const result = await uploadOneItem(
      input.file,
      input.tags,
      { mediaId: input.mediaId, presignedPutUrl: input.presignedPutUrl, requiredContentType: input.requiredContentType },
      i,
      items.length,
      onProgress,
    );
    results.push({ ...result, localId: input.localId });
  }
  return results;
}

/** Voice is unchanged (docs §5.1 — push-to-talk still sends immediately,
 *  never staged): mint a single-item album with no caption, PUT, complete. */
export async function uploadVoice(
  chatId: string,
  file: Blob,
  mime: string,
  replyToId?: string,
  onProgress?: (pct: number) => void,
): Promise<AlbumUploadOutcome> {
  return uploadAlbum(chatId, [{ localId: 'voice', file, kind: 'voice', mime, tags: [] }], undefined, replyToId, (_i, pct) =>
    onProgress?.(pct),
  );
}

export function fetchMediaUrl(mediaId: string): Promise<MediaUrlResponse> {
  return api<MediaUrlResponse>(`/api/media/${mediaId}/url`);
}
