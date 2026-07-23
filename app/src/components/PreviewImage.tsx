import { useState, type ImgHTMLAttributes } from 'react';
import type { MediaInfo } from '@den/shared';

/** Server-side thumb resize box: fit inside 400×400, no enlargement
 *  (server/src/media/process.ts). Video posters are NOT resized — they keep
 *  the frame's dimensions. */
const THUMB_FIT = 400;

/** The natural pixel size of the preview file the `<img>` will display,
 *  computed from the stored media dimensions: the server's fit-inside-400
 *  resize for image thumbs, the raw frame size for video posters. This
 *  mirrors the *server's* pixel processing only — never CSS. All display
 *  clamping (`max-h-72`, `max-w-full`) is left to CSS itself, which scales
 *  replaced elements proportionally, so this stays correct at any root
 *  font-size (OS font scaling turns `18rem` into ≠288px) and any container
 *  width. */
function naturalDims(media: MediaInfo): { width: number; height: number } | undefined {
  let w = media.width;
  let h = media.height;
  if (!w || !h) return undefined;
  if (media.kind === 'image') {
    const s = Math.min(1, THUMB_FIT / w, THUMB_FIT / h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return { width: w, height: h };
}

/** Chat preview `<img>` that reserves its final layout box *before* the bytes
 *  arrive, via `width`/`height` attributes standing in for the natural size.
 *  Without this, previews render at zero height on a cold load, the
 *  open-chat scroll-to-bottom fires against the deflated scrollHeight, and
 *  every image that decodes afterwards pushes the viewport up — the classic
 *  "chat opens scrolled above the bottom after a refresh" bug.
 *
 *  Once the image loads the attributes are dropped and the real natural size
 *  takes over (an invisible handoff when the stored dimensions are right, a
 *  self-heal when they aren't — pre-fix DB rows for EXIF-rotated portrait
 *  photos/videos carry swapped width/height). */
export function PreviewImage({
  media,
  ...imgProps
}: { media: MediaInfo | null | undefined } & ImgHTMLAttributes<HTMLImageElement>) {
  const [loaded, setLoaded] = useState(false);
  const dims = !loaded && media ? naturalDims(media) : undefined;
  return <img {...imgProps} width={dims?.width} height={dims?.height} onLoad={() => setLoaded(true)} />;
}
