/**
 * Klipy GIF resolver (docs/GIFS.md §7) — the `klipy` entry in the provider
 * registry. Shape and lifecycle are a direct copy of `instagram.ts`: fetch
 * remote metadata, snapshot the image bytes to R2 through sharp, return a
 * normalized card. Failures propagate to `finalizeEmbed`, which flips the row
 * to 'failed' and lets the client render its link fallback.
 *
 * The R2 snapshot is the whole point (D2). Rendering straight off Klipy's CDN
 * would be cheaper, but it would (a) put every member's IP in front of a third
 * party on every scroll through chat history, breaking CLAUDE.md invariant 10,
 * and (b) make old messages rot when the provider changes URLs or disappears —
 * which is not hypothetical: this feature exists because Tenor's API was
 * switched off in June 2026. Owning the bytes means a dead provider costs us
 * new searches, never chat history.
 */
import sharp from 'sharp';
import { embedKey, putObjectBuffer } from '../media/r2.js';
import { gifBySlug, klipyPageUrl } from '../gifs/klipy.js';
import type { EmbedResolveCtx, ResolvedEmbed } from './registry.js';

/** Klipy's CDN hosts. The metadata call is host-checked inside gifs/klipy.ts;
 *  this is the second, separate allowlist for the *bytes* fetch, exactly as
 *  instagram.ts keeps its page host and CDN host lists apart. */
const CDN_HOST_SUFFIXES = ['.klipy.com', '.klipy.co'];
const FETCH_TIMEOUT_MS = 15000;
/** A pre-sized rendition is normally well under 5MB; this refuses a hostile or
 *  runaway response before it reaches sharp. */
const MAX_BYTES = 12 * 1024 * 1024;
/** Cap the stored animation's width. Chat renders these small, and an
 *  oversized source is the difference between a ~200KB store and several MB
 *  (docs/GIFS.md §10 — cost stays negligible only if we keep it deliberate). */
const MAX_STORED_WIDTH = 320;

function isAllowedCdnHost(host: string): boolean {
  return CDN_HOST_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
}

async function fetchImageBytes(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('GIF asset must be https');
  if (!isAllowedCdnHost(parsed.host)) throw new Error(`GIF asset host not allowed: ${parsed.host}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // `redirect: 'error'` rather than following hops: a redirect off the
    // allowlisted CDN is precisely the case the allowlist exists to stop, and
    // there is no legitimate reason for a rendition URL to bounce.
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`GIF asset fetch failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new Error('GIF asset too large');
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveKlipy(ctx: EmbedResolveCtx): Promise<ResolvedEmbed> {
  const item = await gifBySlug(ctx.providerRef);
  if (!item) throw new Error(`Klipy returned no usable item for slug ${ctx.providerRef}`);

  // `item.source`, not `item.preview`: the picker's tile rendition is chosen to
  // be small enough to scroll two dozen of, which is too small to keep.
  const source = await fetchImageBytes(item.source.url);

  // Animated WebP, not MP4 (D6): re-encoding through sharp is the exact path
  // instagram.ts already uses, and an <img> sidesteps every iOS autoplay rule
  // that a <video> would drag in. `animated: true` on BOTH the read and the
  // encode — omitting it on the read silently keeps only the first frame.
  const pipeline = sharp(source, { animated: true, failOn: 'none' });
  const meta = await pipeline.metadata();
  const encoded = await pipeline
    .resize({ width: Math.min(meta.width ?? item.source.width, MAX_STORED_WIDTH), withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  const key = embedKey(ctx.chatId, ctx.embedId, 'gif.webp');
  await putObjectBuffer(key, encoded.data, 'image/webp');

  // Dimensions come from what we ACTUALLY stored, not from what Klipy claimed:
  // the client reserves its layout box from these (docs/GIFS.md §8), so a
  // mismatch after resizing would reintroduce the scroll-jump this is meant to
  // prevent. Re-reading the encoded buffer's metadata (headers only, no full
  // decode) is worth it for `pageHeight` — the height of ONE frame. Animated
  // output reports `info.height` as every frame stacked vertically, so using
  // it would reserve a box dozens of times too tall.
  const storedMeta = await sharp(encoded.data).metadata();
  const storedWidth = storedMeta.width ?? encoded.info.width;
  const storedHeight = storedMeta.pageHeight ?? storedMeta.height ?? encoded.info.height;

  return {
    title: item.title,
    subtitle: null,
    description: null,
    thumbKey: key,
    // Klipy's page for the item. Nothing links to it while the card renders
    // (`actionType: 'inline'`), but it's the only user-facing URL this embed
    // has, so it's what the failure fallback would show — and it's provenance
    // for a row whose bytes now live in our own bucket.
    canonicalUrl: klipyPageUrl(item.slug),
    // The canonical, suffix-free slug from the API — NOT `ctx.providerRef`,
    // which came from a search result and carries that response's analytics
    // suffix (docs/GIFS.md §12). Storing the durable form means a re-resolve
    // years from now asks for the thing itself, not a dead session token.
    providerRef: item.slug,
    contentKind: 'gif',
    actionType: 'inline',
    data: { width: storedWidth, height: storedHeight, mimeType: 'image/webp' },
  };
}
