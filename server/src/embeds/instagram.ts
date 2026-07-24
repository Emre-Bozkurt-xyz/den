/**
 * Instagram embed resolver (docs/EMBEDS.md §4.3) — Den's first server-side
 * fetch of a user-supplied URL. Treated as hostile input end to end:
 *
 *   1. The URL itself is only ever an already-validated `DetectedEmbed.url`
 *      (shared/src/embeds.ts's strict `instagram.com/reel|p/{shortcode}`
 *      regex) by the time a resolver ever sees it — nothing here re-trusts
 *      raw client input.
 *   2. `safeFetch` below is the SSRF containment: a fixed host allowlist
 *      (exact-or-suffix match), HTTPS only, a hard per-hop timeout, a
 *      response-size cap, and *manual* redirect handling that re-checks the
 *      allowlist on every hop — a redirect to an off-allowlist host is
 *      refused, never silently followed.
 *   3. The `og:image` snapshot is re-encoded through sharp exactly like the
 *      image pipeline (media/process.ts): this both strips metadata and
 *      "verifies by attempting decode" (CLAUDE.md #7) — a non-image response
 *      makes sharp throw, which degrades to a thumbnail-less card rather
 *      than trusting the declared Content-Type.
 *
 * IG's official oEmbed now needs an FB app token; unauthenticated OG-tag
 * scraping of the public page is the pragmatic default the plan doc calls
 * for. ⚠️ Unverified against the real instagram.com in this environment (no
 * outbound network in the sandbox, and IG's anti-scraping posture may return
 * a login-wall page with no OG tags for some requests) — see the executor
 * report for what a live verification pass needs to check.
 */
import sharp from 'sharp';
import type { EmbedResolveCtx, EmbedResolver, ResolvedEmbed } from './registry.js';
import { embedKey, putObjectBuffer } from '../media/r2.js';

const FETCH_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;
// Plenty for an OG-tagged HTML page or a CDN thumbnail; nowhere near enough
// to turn this into a storage/bandwidth DoS vector (docs/EMBEDS.md §4.3 SSRF
// containment: "response-size cap").
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Fixed host allowlists (docs/EMBEDS.md §4.3: "fetch only fixed Instagram
// hosts"). The page lives on instagram.com; the og:image it points at is
// served from Meta's CDN, a *different* host family — both are enumerated
// explicitly rather than "whatever the page happened to redirect to".
const IG_PAGE_HOSTS = ['instagram.com'];
const IG_CDN_HOSTS = ['cdninstagram.com', 'fbcdn.net'];

function hostAllowed(hostname: string, allowedSuffixes: string[]): boolean {
  return allowedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Fetches `urlStr`, following only same-allowlist HTTPS redirects (manual
 *  mode — never `redirect: 'follow'`, which would trust wherever the server
 *  sends us), capped at `MAX_RESPONSE_BYTES` and `FETCH_TIMEOUT_MS` per hop. */
async function safeFetch(urlStr: string, allowedHostSuffixes: string[]): Promise<Buffer> {
  let current = new URL(urlStr);

  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:') throw new Error(`refusing non-https URL: ${current.protocol}`);
    if (!hostAllowed(current.hostname, allowedHostSuffixes)) {
      throw new Error(`host not on the embed allowlist: ${current.hostname}`);
    }
    if (hop > MAX_REDIRECTS) throw new Error('too many redirects');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          // A generic browser-ish UA — IG serves a no-JS login wall to some
          // bare-bones clients regardless of this, but an obviously-a-bot UA
          // makes that strictly worse.
          'user-agent': 'Mozilla/5.0 (compatible; DenEmbedBot/1.0; +https://den.ems-place.com)',
          accept: 'text/html,image/*,*/*',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('redirect response with no Location header');
      const next = new URL(location, current);
      // Re-validated at the top of the next loop iteration too, but fail
      // fast here with a clearer error — this IS the "no redirects to
      // non-IG hosts" requirement (docs/EMBEDS.md §4.3).
      if (next.protocol !== 'https:' || !hostAllowed(next.hostname, allowedHostSuffixes)) {
        throw new Error(`redirect left the embed allowlist: ${next.hostname}`);
      }
      current = next;
      continue;
    }

    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);

    const declaredLength = res.headers.get('content-length');
    if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      throw new Error('declared response size exceeds the embed cap');
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('empty response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('response exceeded the embed size cap mid-stream');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
}

/** Handles both meta-tag attribute orderings (`property` then `content`, or
 *  vice versa) — IG's markup isn't a contract Den controls, so this doesn't
 *  assume one order. Returns the first match, HTML-entity-decoded. */
function extractMetaContent(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const propThenContent = new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i');
  const contentThenProp = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${escaped}["']`, 'i');
  const match = propThenContent.exec(html) ?? contentThenProp.exec(html);
  return match ? decodeHtmlEntities(match[1]!) : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** IG's og:title is typically `"N Likes, M Comments - handle on Instagram: "caption""`
 *  — pull just the handle as the card's subtitle when the shape matches;
 *  otherwise leave subtitle null rather than showing the whole noisy string. */
function subtitleFromOgTitle(ogTitle: string | null): string | null {
  if (!ogTitle) return null;
  const m = /-\s*([^:]+?)\s+on Instagram/i.exec(ogTitle);
  return m ? `@${m[1]!.trim().replace(/^@/, '')}` : null;
}

export const resolveInstagram: EmbedResolver = async (ctx: EmbedResolveCtx): Promise<ResolvedEmbed> => {
  const pageBuf = await safeFetch(ctx.url, IG_PAGE_HOSTS);
  const html = pageBuf.toString('utf8');

  const ogImage = extractMetaContent(html, 'og:image');
  const ogTitle = extractMetaContent(html, 'og:title');
  const ogDescription = extractMetaContent(html, 'og:description');
  const ogVideo = extractMetaContent(html, 'og:video');

  // A private reel, a deleted post, or IG serving its no-JS login wall
  // instead of the real page all look the same here: zero OpenGraph tags.
  // Treat that as a resolver failure (→ status='failed', link fallback) —
  // §8's verification explicitly wants "bad/private URL → link fallback",
  // not a hollow 'ready' card with nothing in it.
  if (!ogImage && !ogTitle && !ogDescription) {
    throw new Error('no OpenGraph data found on the Instagram page (private/deleted/login-wall)');
  }

  // Snapshot og:image → R2, re-encoded WebP (docs/EMBEDS.md §4.3: strips
  // metadata, and IG's CDN URLs are short-lived so Den must own the bytes).
  // Best-effort: a snapshot failure degrades to a thumbnail-less card, it
  // does not fail the whole embed (mirrors media/process.ts's poster-frame
  // best-effort posture).
  let thumbKey: string | null = null;
  if (ogImage) {
    try {
      const imgBuf = await safeFetch(ogImage, IG_CDN_HOSTS);
      const webp = await sharp(imgBuf, { failOn: 'none' }).webp({ quality: 85 }).toBuffer();
      const key = embedKey(ctx.chatId, ctx.embedId, 'thumb.webp');
      await putObjectBuffer(key, webp, 'image/webp');
      thumbKey = key;
    } catch (err) {
      console.error(`instagram og:image snapshot failed for embed ${ctx.embedId}:`, err instanceof Error ? err.message : err);
      thumbKey = null;
    }
  }

  return {
    title: ogTitle,
    subtitle: subtitleFromOgTitle(ogTitle),
    description: ogDescription,
    thumbKey,
    canonicalUrl: ctx.url,
    contentKind: 'video',
    actionType: 'external',
    data: ogVideo ? { ogVideoUrl: ogVideo } : undefined,
  };
};
