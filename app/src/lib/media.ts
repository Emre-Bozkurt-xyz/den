import type { CompleteUploadRequest, CreateUploadRequest, CreateUploadResponse, MediaKind, MediaUrlResponse, Message } from '@den/shared';
import { api } from './api';

/** Best-effort kind from a picked file's mime — matches the three §7 kinds.
 *  Anything else (docs, etc.) isn't part of MVP scope. */
export function kindForMime(mime: string): MediaKind | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'voice';
  return null;
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
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(body);
  });
}

/** Full §7 upload flow: mint → PUT → complete. The resulting message (a
 *  'processing' placeholder) also arrives over WS to every member, including
 *  this tab — we don't need to hand-insert it into the query cache here. */
export async function uploadMedia(
  chatId: string,
  file: Blob,
  kind: MediaKind,
  mime: string,
  caption: string | undefined,
  onProgress?: (pct: number) => void,
): Promise<Message> {
  const createBody: CreateUploadRequest = { chatId, kind, mime, sizeBytes: file.size };
  const created = await api<CreateUploadResponse>('/api/media/uploads', {
    method: 'POST',
    body: JSON.stringify(createBody),
  });

  await putWithProgress(created.presignedPutUrl, file, created.requiredContentType, onProgress);

  const completeBody: CompleteUploadRequest = caption?.trim() ? { body: caption.trim() } : {};
  return api<Message>(`/api/media/${created.mediaId}/complete`, {
    method: 'POST',
    body: JSON.stringify(completeBody),
  });
}

export function fetchMediaUrl(mediaId: string): Promise<MediaUrlResponse> {
  return api<MediaUrlResponse>(`/api/media/${mediaId}/url`);
}
