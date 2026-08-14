/**
 * Client-declared aspect hints (docs/GIFS.md §6, docs/MEDIA_ATTACHMENTS.md
 * §4.6) — one pure, unit-tested clamp shared by the GIF picker and the media
 * upload path, so both treat client-supplied dimensions identically.
 *
 * **Why hints exist.** Both features broadcast a `'processing'` row to every
 * other member before the server has measured anything: a GIF before its
 * resolver fetches, media before its sharp/ffprobe pass. Without a size, those
 * placeholders render as a fixed generic box and then pop to the real shape
 * when the bytes land — jarring, and for media it also shifts the message list
 * under a reader (the same class of problem `PreviewImage` exists to fix).
 * The sender's own device already knows the aspect ratio at that moment. The
 * information exists; it just has to survive the trip to everyone else.
 *
 * **Why accepting it doesn't weaken invariant 7.** CLAUDE.md's "never trust
 * client-declared mime/size" governs decisions about what gets *fetched,
 * stored, and served* — it is why `completeUpload` HEAD-verifies and sniffs
 * before marking anything ready. A hint touches none of that. It is written
 * only as a provisional size, is always overwritten by the server's own
 * measurement on success, and on failure sits on a row that no read path
 * renders. The realistic abuse is a garbage ratio reserving an absurd box,
 * which is exactly what the clamp removes.
 *
 * **What it is NOT for:** never size-check, bill, allocate, or make a storage
 * decision from these numbers. They are a layout courtesy, nothing more.
 */

/** Bounds wide enough for real content — panoramas and full-page screenshots
 *  genuinely reach ~5:1 — and narrow enough that a hostile value can't reserve
 *  a pathological box. */
const MIN_ASPECT = 1 / 5;
const MAX_ASPECT = 5;

/** Hints are normalized to this width so what lands in the database reads as a
 *  ratio rather than a pixel claim that was never verified. Every consumer
 *  (masonry packing, `PreviewImage`'s reserved box, the GIF card) uses only
 *  `width / height`, so normalizing costs nothing. */
const NOMINAL_WIDTH = 240;

/**
 * Returns clamped, normalized `{width, height}`, or `undefined` when there is
 * no usable hint — in which case callers fall back to their existing generic
 * placeholder, which is visibly neutral rather than confidently wrong.
 */
export function aspectHint(width: unknown, height: unknown): { width: number; height: number } | undefined {
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;

  const aspect = Math.min(Math.max(width / height, MIN_ASPECT), MAX_ASPECT);
  return { width: NOMINAL_WIDTH, height: Math.round(NOMINAL_WIDTH / aspect) };
}
