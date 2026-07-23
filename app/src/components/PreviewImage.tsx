import { useState, type CSSProperties, type ImgHTMLAttributes } from 'react';
import type { MediaInfo } from '@den/shared';

/** Server-side thumb resize box: fit inside 400×400, no enlargement
 *  (server/src/media/process.ts). Video posters are NOT resized — they keep
 *  the frame's dimensions. */
const THUMB_FIT = 400;
/** `max-h-72` (18rem at the 16px root) — every chat preview `<img>` carries
 *  it, so the reservation math applies the same clamp numerically. */
const MAX_H = 288;

/** The final layout box for a chat media preview, computed from the stored
 *  media dimensions the same way the browser would from the loaded bytes:
 *  image thumbs first scaled to the server's fit-inside-400 box, then the
 *  max-h-72 clamp applied ratio-preserving. Width is set explicitly and
 *  height left to `aspect-ratio`, so the runtime `max-w-full` clamp (narrow
 *  phone columns) still resolves height proportionally. */
function reservedStyle(media: MediaInfo): CSSProperties | undefined {
  let w = media.width;
  let h = media.height;
  if (!w || !h) return undefined;
  if (media.kind === 'image') {
    const s = Math.min(1, THUMB_FIT / w, THUMB_FIT / h);
    w *= s;
    h *= s;
  }
  if (h > MAX_H) {
    w *= MAX_H / h;
    h = MAX_H;
  }
  return { width: Math.round(w), aspectRatio: `${media.width} / ${media.height}` };
}

/** Chat preview `<img>` that reserves its final layout box *before* the bytes
 *  arrive. Without this, previews render at zero height on a cold load, the
 *  open-chat scroll-to-bottom fires against the deflated scrollHeight, and
 *  every image that decodes afterwards pushes the viewport up — the classic
 *  "chat opens scrolled above the bottom after a refresh" bug.
 *
 *  Once the image loads the inline reservation is dropped and natural sizing
 *  takes over (an invisible handoff when the stored dimensions are right, a
 *  self-heal when they aren't — pre-fix DB rows for EXIF-rotated portrait
 *  photos/videos carry swapped width/height). */
export function PreviewImage({
  media,
  style,
  ...imgProps
}: { media: MediaInfo | null | undefined } & ImgHTMLAttributes<HTMLImageElement>) {
  const [loaded, setLoaded] = useState(false);
  const reserved = !loaded && media ? reservedStyle(media) : undefined;
  return <img {...imgProps} style={{ ...style, ...reserved }} onLoad={() => setLoaded(true)} />;
}
