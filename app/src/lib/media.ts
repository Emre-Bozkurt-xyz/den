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
import { holdBusy } from './busy';
import { createStallWatchdog } from './stallWatchdog';

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

/** Thrown by `putWithProgress` when the PUT didn't fail so much as get cut
 *  off: `stalled` = the watchdog gave up on a connection that stopped moving
 *  bytes; `aborted` = the caller's `AbortSignal` fired (user cancel). Either
 *  way the presigned URL is still good, so the item is retryable as-is. */
export class UploadInterruptedError extends Error {
  readonly reason: 'stalled' | 'aborted';
  constructor(reason: 'stalled' | 'aborted') {
    super(reason === 'stalled' ? 'Upload stalled' : 'Upload cancelled');
    this.name = 'UploadInterruptedError';
    this.reason = reason;
  }
}

/** Same zombie-connection reasoning as api.ts's `REQUEST_TIMEOUT_MS`: a PUT
 *  over a TCP connection the radio dropped (or that iOS froze with the PWA)
 *  doesn't fail, it hangs — and with it the composer and the serial album
 *  loop. But a PUT can legitimately run for minutes, so this is an IDLE
 *  window (no progress event for this long → give up), not a total cap. */
const PUT_STALL_MS = 30_000;
/** Once the browser reports the whole body sent (`upload.onload`), there are
 *  no more progress events to reset the idle window while we wait for R2's
 *  response — and "sent" means handed to the network stack, which can buffer
 *  a lot (HTTP/2 / QUIC windows) that is still draining over a slow link.
 *  A longer, still bounded, wait for that last stretch avoids false stalls. */
const PUT_RESPONSE_WAIT_MS = 90_000;

/** PUT straight to R2/MinIO with upload progress (XHR gives progress events;
 *  fetch's upload-stream API isn't there yet cross-browser). No credentials —
 *  the presigned URL's signature *is* the auth (hard invariant 2).
 *
 *  Always settles: resolve on 2xx; `UploadHttpError` on any other status;
 *  `UploadInterruptedError` on stall or `signal` abort; plain `Error` on a
 *  network error. */
function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadInterruptedError('aborted'));
      return;
    }
    const xhr = new XMLHttpRequest();
    // Both cut-offs settle FIRST and abort second: the promise then carries
    // the right reason (`onabort` can't tell them apart), and it settles even
    // if a suspended/resumed WebKit never dispatches the abort event.
    const watchdog = createStallWatchdog(() => {
      settle(new UploadInterruptedError('stalled'));
      xhr.abort();
    });
    const onSignalAbort = () => {
      settle(new UploadInterruptedError('aborted'));
      xhr.abort();
    };
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    let settled = false;
    function settle(err?: Error) {
      if (settled) return;
      settled = true;
      watchdog.stop();
      signal?.removeEventListener('abort', onSignalAbort);
      if (err) reject(err);
      else resolve();
    }

    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      watchdog.kick(PUT_STALL_MS);
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => watchdog.kick(PUT_RESPONSE_WAIT_MS);
    xhr.onload = () => settle(xhr.status >= 200 && xhr.status < 300 ? undefined : new UploadHttpError(xhr.status));
    xhr.onerror = () => settle(new Error('Upload network error'));
    xhr.onabort = () => settle(new UploadInterruptedError('aborted'));
    // `xhr.timeout` is never set (it would be a total cap — see PUT_STALL_MS),
    // so this shouldn't fire; handled so no event can leave the promise open.
    xhr.ontimeout = () => settle(new UploadInterruptedError('stalled'));
    // Armed before send: a connection that never gets going (no first
    // progress event) is the same hang.
    watchdog.kick(PUT_STALL_MS);
    xhr.send(body);
  });
}

/** One signal that aborts when any of `signals` does — `AbortSignal.any` is
 *  only Safari 17.4+, too new to assume for the iPhones in the circle.
 *  `release` detaches the listeners (the album-level signal outlives each
 *  item, so they'd otherwise pile up on it). */
function linkSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; release: () => void } {
  const ctrl = new AbortController();
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  const onAbort = () => ctrl.abort();
  for (const s of live) {
    if (s.aborted) ctrl.abort();
    else s.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ctrl.signal, release: () => live.forEach((s) => s.removeEventListener('abort', onAbort)) };
}

/** Optional controls for the upload entry points below. */
export interface UploadOptions {
  /** Cancels the whole operation: the in-flight PUT is aborted and every item
   *  not yet completed comes back `ok: false, interrupted: 'aborted'` (with
   *  its mint info, so `retryAlbumItems` can pick it up). Already aborted
   *  when `uploadAlbum` is called → rejects with
   *  `UploadInterruptedError('aborted')` and nothing is minted. The mint and
   *  `complete` calls themselves are never aborted mid-flight (a cancel
   *  during one takes effect when it returns): cutting one off would leave
   *  the client unsure whether the server acted on it. */
  signal?: AbortSignal;
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
  /** Set when the item didn't fail so much as get cut off: `stalled` (the
   *  PUT watchdog gave up) or `aborted` (a caller signal fired, before or
   *  during its PUT, or before its `complete`). Null for every other
   *  outcome. Interrupted items are ordinary failures as far as retry goes. */
  interrupted: 'stalled' | 'aborted' | null;
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
  signal?: AbortSignal,
): Promise<AlbumItemResult> {
  const base = { localId: mint.mediaId, mediaId: mint.mediaId, presignedPutUrl: mint.presignedPutUrl, requiredContentType: mint.requiredContentType };
  const aborted: AlbumItemResult = { ...base, ok: false, expired: false, interrupted: 'aborted' };
  if (signal?.aborted) return aborted;
  try {
    await putWithProgress(mint.presignedPutUrl, file, mint.requiredContentType, (pct) => onProgress?.(index, pct, total), signal);
  } catch (e) {
    return {
      ...base,
      ok: false,
      expired: e instanceof UploadHttpError && (e.status === 403 || e.status === 400),
      interrupted: e instanceof UploadInterruptedError ? e.reason : null,
    };
  }
  // Cancelled after the bytes landed but before `complete`: skip it. An item
  // that's never completed is never fanned out, which is what "cancel" means
  // to the user; the cost is a re-PUT if they retry instead.
  if (signal?.aborted) return aborted;
  try {
    const completeBody: CompleteUploadRequest = tags.length > 0 ? { tags } : {};
    await api<Message>(`/api/media/${mint.mediaId}/complete`, { method: 'POST', body: JSON.stringify(completeBody) });
    onProgress?.(index, 100, total);
    return { ...base, ok: true, expired: false, interrupted: null };
  } catch {
    return { ...base, ok: false, expired: false, interrupted: null };
  }
}

/** The serial PUT+complete loop shared by `uploadAlbum` and
 *  `retryAlbumItems`. Each item may carry its own `signal` (cancel just that
 *  one — the tray's ✕) on top of the operation-wide `opts.signal`. */
async function uploadItemsSerially(
  items: { localId: string; file: Blob; tags: string[]; signal?: AbortSignal }[],
  mints: { mediaId: string; presignedPutUrl: string; requiredContentType: string }[],
  onProgress: ((itemIndex: number, itemPct: number, total: number) => void) | undefined,
  opts: UploadOptions | undefined,
): Promise<AlbumItemResult[]> {
  const results: AlbumItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const input = items[i]!;
    const linked = linkSignals(opts?.signal, input.signal);
    try {
      const result = await uploadOneItem(input.file, input.tags, mints[i]!, i, items.length, onProgress, linked.signal);
      results.push({ ...result, localId: input.localId });
    } finally {
      linked.release();
    }
  }
  return results;
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
 *
 * Cancellation: `opts.signal` for the whole album, or a per-item `signal`
 * (see `UploadOptions`). Holds `busy('upload')` for its whole duration so an
 * SW update can't reload the page out from under it (`lib/pwa.ts`); the
 * finally makes sure that hold can't outlive the call.
 */
export async function uploadAlbum(
  chatId: string,
  items: { localId: string; file: Blob; kind: MediaKind; mime: string; tags: string[]; signal?: AbortSignal }[],
  caption: string | undefined,
  replyToId: string | undefined,
  onProgress?: (itemIndex: number, itemPct: number, total: number) => void,
  opts?: UploadOptions,
): Promise<AlbumUploadOutcome> {
  if (opts?.signal?.aborted) throw new UploadInterruptedError('aborted');
  const release = holdBusy('upload');
  try {
    // docs/MEDIA_ATTACHMENTS.md §4.6 — measure intrinsic sizes before minting so
    // every other member's 'processing' placeholder has the right aspect from
    // the moment the album appears. Measured here rather than in `stageFiles`
    // because that's a synchronous pure helper and this is the one place that
    // already awaits; a failure to measure just omits the hint.
    const sizes = await Promise.all(items.map((i) => intrinsicSize(i.file, i.kind)));

    const createBody: CreateUploadRequest = {
      chatId,
      items: items.map((i, idx) => ({ kind: i.kind, mime: i.mime, sizeBytes: i.file.size, ...(sizes[idx] ?? {}) })),
      ...(caption?.trim() ? { caption: caption.trim() } : {}),
      ...(replyToId ? { replyToId } : {}),
    };
    const created = await api<CreateUploadResponse>('/api/media/uploads', {
      method: 'POST',
      body: JSON.stringify(createBody),
    });

    const results = await uploadItemsSerially(items, created.items, onProgress, opts);
    return { messageId: created.messageId, items: results };
  } finally {
    release();
  }
}

/**
 * Reads a file's intrinsic pixel size without decoding the whole thing into a
 * canvas — `<img>`/`<video>` metadata is enough, and both report the
 * *display* orientation the server will eventually store (the server re-derives
 * it anyway, EXIF and rotation-matrix included; see PROJECT.md §14 2026-07-22).
 *
 * Best-effort by design: an unsupported/undecodable file (HEIC in Chrome is the
 * common one — docs/MEDIA_ATTACHMENTS.md §5.7) resolves to `null` and the
 * upload simply carries no hint, falling back to today's generic placeholder.
 * It never rejects, never blocks the send, and is capped by a timeout so a
 * pathological file can't stall an album behind metadata that will never load.
 */
async function intrinsicSize(file: Blob, kind: MediaKind): Promise<{ width: number; height: number } | null> {
  if (kind !== 'image' && kind !== 'video') return null;

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<{ width: number; height: number } | null>((resolve) => {
      const timeout = window.setTimeout(() => finish(null), 3000);
      function finish(value: { width: number; height: number } | null) {
        window.clearTimeout(timeout);
        resolve(value);
      }

      if (kind === 'image') {
        const img = new Image();
        img.onload = () => finish(img.naturalWidth && img.naturalHeight ? { width: img.naturalWidth, height: img.naturalHeight } : null);
        img.onerror = () => finish(null);
        img.src = url;
      } else {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => finish(video.videoWidth && video.videoHeight ? { width: video.videoWidth, height: video.videoHeight } : null);
        video.onerror = () => finish(null);
        video.src = url;
      }
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Retries already-minted items (mint succeeded, PUT and/or complete didn't)
 *  by re-PUTting to their still-valid presigned URLs — no re-mint, so this
 *  stays scoped to the *same* album message. Callers should check
 *  `AlbumItemResult.expired` on a fresh failure and fall back to minting a
 *  brand-new album (`uploadAlbum`) + discarding the orphaned old message
 *  (docs §5.1: "expired URLs → re-mint as a new album and discard the old").
 *  Same cancellation and busy-hold behaviour as `uploadAlbum`. */
export async function retryAlbumItems(
  items: {
    localId: string;
    file: Blob;
    tags: string[];
    mediaId: string;
    presignedPutUrl: string;
    requiredContentType: string;
    signal?: AbortSignal;
  }[],
  onProgress?: (itemIndex: number, itemPct: number, total: number) => void,
  opts?: UploadOptions,
): Promise<AlbumItemResult[]> {
  const release = holdBusy('upload');
  try {
    return await uploadItemsSerially(items, items, onProgress, opts);
  } finally {
    release();
  }
}

/** Voice is unchanged (docs §5.1 — push-to-talk still sends immediately,
 *  never staged): mint a single-item album with no caption, PUT, complete. */
export async function uploadVoice(
  chatId: string,
  file: Blob,
  mime: string,
  replyToId?: string,
  onProgress?: (pct: number) => void,
  opts?: UploadOptions,
): Promise<AlbumUploadOutcome> {
  return uploadAlbum(
    chatId,
    [{ localId: 'voice', file, kind: 'voice', mime, tags: [] }],
    undefined,
    replyToId,
    (_i, pct) => onProgress?.(pct),
    opts,
  );
}

export function fetchMediaUrl(mediaId: string): Promise<MediaUrlResponse> {
  return api<MediaUrlResponse>(`/api/media/${mediaId}/url`);
}
