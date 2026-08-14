/**
 * Klipy API client (docs/GIFS.md §7) — the ONLY module that knows Klipy's
 * wire format. Everything downstream (routes/gifs.ts, embeds/klipy.ts) speaks
 * the normalized shapes below, which is what keeps the provider swappable:
 * this feature exists because Google discontinued Tenor's public API in June
 * 2026, and Klipy is a young, ad-funded company we are deliberately not paying
 * (docs/GIFS.md §2). Assume a swap will happen.
 *
 * Same hostile-input posture as embeds/instagram.ts, and for a sharper reason:
 * Klipy's native API interpolates the API key AND the slug into the URL
 * *path*, so an unvalidated slug is a request-forgery primitive against our
 * own outbound call, not merely bad data.
 *
 * Response schema confirmed against the live API 2026-08-13 (docs/GIFS.md §12).
 */
import { ErrorCode, type GifRating, type GifSearchItem, type GifSearchResponse, GifLimits } from '@den/shared';
import { env } from '../env.js';
import { AppError, unavailable } from '../errors.js';

const API_HOST = 'api.klipy.com';
const FETCH_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Slugs are interpolated into an outbound URL path, so they are validated as
 * hostile input rather than trusted because "they came from our own search
 * results" — the client is the one echoing them back, and per CLAUDE.md
 * invariant 7 the client is never trusted. A conservative charset also rules
 * out `.` and `/`, and therefore path traversal in the request we build.
 */
const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidGifSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

function requireKey(): string {
  const key = env.klipyApiKey;
  if (!key) throw unavailable('GIF search is not configured');
  return key;
}

/** Builds a native-v1 URL. The key sits in the path (Klipy's design, not
 *  ours), which is why `klipyApiKey` may never reach a client. */
function apiUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`https://${API_HOST}/api/v1/${requireKey()}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Sentinel for "the provider says this item doesn't exist", as distinct from
 *  "the provider is broken". Only `gifBySlug` asks for it — a 404 on a *search*
 *  really is a provider fault. */
const NOT_FOUND = Symbol('klipy-not-found');

async function fetchJson(url: string, notFoundAsNull = false): Promise<unknown> {
  // Belt-and-braces: even though we built this URL ourselves, re-assert the
  // host so a future refactor can't turn a caller-supplied string into an
  // arbitrary outbound fetch.
  if (new URL(url).host !== API_HOST) throw new AppError(500, ErrorCode.Internal, 'refusing non-Klipy fetch');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new AppError(502, ErrorCode.ServiceUnavailable, 'GIF provider response too large');
    // A by-slug 404 means the item is gone, not that Klipy is broken — the
    // caller turns this into a clean 404 rather than a "provider error" that
    // wrongly blames the integration for a GIF that was simply deleted.
    if (res.status === 404 && notFoundAsNull) return NOT_FOUND;
    // Never surface Klipy's body: on an invalid key it echoes the key back.
    if (!res.ok) throw new AppError(502, ErrorCode.ServiceUnavailable, `GIF provider error (${res.status})`);
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError(502, ErrorCode.ServiceUnavailable, 'GIF provider returned malformed JSON');
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, ErrorCode.ServiceUnavailable, 'GIF provider unreachable');
  } finally {
    clearTimeout(timeout);
  }
}

// ─── response mapping (schema confirmed 2026-08-13) ─────────────────────────

/**
 * A Klipy item's `file` is nested **two** levels: size tier → format → asset.
 *
 *   file: { hd|md|sm|xs: { gif|webp|jpg|mp4|webm: { url, width, height, size } } }
 *
 * `xs` is a genuinely smaller image (87×90 in the sample); the larger tiers
 * often share dimensions and differ only in encoding, so tier is a request for
 * a size *budget*, not a guarantee of distinct pixels.
 */
interface KlipyAsset {
  url: string;
  width: number;
  height: number;
}

/** Internal, richer than the client DTO: the picker and the resolver want
 *  different renditions of the same item (a small one to scroll through, a
 *  larger one to store), so one URL per item isn't enough. */
export interface KlipyItem {
  /** Canonical, suffix-free slug **as reported by the API**, never the one we
   *  asked with — see `gifBySlug`. */
  slug: string;
  /** Klipy's stable per-item id, stringified (docs/GIF_FAVORITES.md §2).
   *
   *  Not a lookup key — `gifs/{id}` 404s, slug is the only handle — but it IS
   *  stable identity: measured 2026-08-14, a search result and its own
   *  canonicalized by-slug response report the same id despite different
   *  slugs. That is what lets the picker tell whether a result is already
   *  favorited, which the rotating slug suffix otherwise makes impossible.
   *
   *  **Nullable, and every consumer must degrade rather than drop.** This is
   *  the documented floor from §2: an item whose id we can't read is still a
   *  perfectly good GIF — it renders, it sends, and it can still be favorited
   *  (favoriting posts a slug; the id is read from the *resolver's* response).
   *  All that is lost is the picker's ability to pre-fill its star. Dropping
   *  the item instead would empty the picker over a cosmetic field. */
  itemId: string | null;
  title: string;
  preview: KlipyAsset;
  source: KlipyAsset;
}

function readAsset(raw: unknown): KlipyAsset | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  const { url, width, height } = a;
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { url, width: Math.round(width), height: Math.round(height) };
}

/** Tier names are NOT a reliable size ordering — measured 2026-08-13, one item
 *  returned `hd.webp` at 71KB but `md.webp` and `sm.webp` both at 137KB, with
 *  all three the same 220px width. So tiers are enumerated, not ranked, and
 *  selection happens on the declared dimensions below. */
const TIERS = ['xs', 'sm', 'md', 'hd'] as const;
/** Animated formats only, best first. `jpg` is a still frame and would
 *  silently turn a GIF into a photo; `mp4`/`webm` are excluded because we
 *  re-encode to animated WebP (D6) and sharp cannot read video. */
const ANIMATED_FORMATS = ['webp', 'gif'] as const;

/** Every animated rendition of an item, flattened out of the tier→format
 *  nesting, de-duplicated by URL and sorted narrowest-first. */
function assetsOf(file: unknown): KlipyAsset[] {
  if (typeof file !== 'object' || file === null) return [];
  const bag = file as Record<string, unknown>;
  const out = new Map<string, KlipyAsset>();
  for (const tier of TIERS) {
    const group = bag[tier];
    if (typeof group !== 'object' || group === null) continue;
    for (const format of ANIMATED_FORMATS) {
      const asset = readAsset((group as Record<string, unknown>)[format]);
      if (asset && !out.has(asset.url)) out.set(asset.url, asset);
    }
  }
  return [...out.values()].sort((a, b) => a.width - b.width);
}

/** The narrowest rendition at least `minWidth` across, falling back to the
 *  widest available when everything is smaller than that (a low-resolution
 *  source simply has nothing better to offer). */
function pickByWidth(assets: KlipyAsset[], minWidth: number): KlipyAsset | null {
  return assets.find((a) => a.width >= minWidth) ?? assets[assets.length - 1] ?? null;
}

/** Picker tiles render ~185px wide in the 2-column mobile grid, so anything
 *  narrower than this visibly upscales. Measured: the `xs` tier came back at
 *  87px, which would have been soft on every phone. */
const PREVIEW_MIN_WIDTH = 200;
/** The resolver caps stored width at 320px, so asking for more than that only
 *  means downloading bytes to throw away. */
const SOURCE_MIN_WIDTH = 320;

/** Klipy reports `id` as a JSON number ~16 digits long. That is inside
 *  double-precision's exact-integer range (2^53 ≈ 9.0e15 — a 16-digit id is
 *  right at the edge), so it is read back defensively: anything that isn't a
 *  safe integer is treated as "no id" rather than stringified into a value
 *  that might have already lost its low digits in the JSON parse. A missing id
 *  costs an unfilled star (docs/GIF_FAVORITES.md §2), never a wrong match. */
function readItemId(raw: unknown): string | null {
  if (typeof raw === 'string' && /^[0-9]{1,32}$/.test(raw)) return raw;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) return null;
  return String(raw);
}

function mapItem(raw: unknown): KlipyItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!isValidGifSlug(r.slug)) return null;

  const assets = assetsOf(r.file);
  const preview = pickByWidth(assets, PREVIEW_MIN_WIDTH);
  const source = pickByWidth(assets, SOURCE_MIN_WIDTH);
  // Drop anything we can't fully understand rather than emitting a partial
  // item: a tile with no dimensions can't reserve its box, and per
  // docs/GIFS.md §8 an unreserved box regresses the chat's scroll-to-bottom.
  if (!preview || !source) return null;

  return {
    slug: r.slug,
    itemId: readItemId(r.id),
    title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : 'GIF',
    preview,
    source,
  };
}

/** The client only ever needs the preview rendition, the slug, and the id it
 *  matches favorites on. */
function toSearchItem(item: KlipyItem): GifSearchItem {
  return {
    slug: item.slug,
    itemId: item.itemId,
    previewUrl: item.preview.url,
    width: item.preview.width,
    height: item.preview.height,
    title: item.title,
  };
}

function mapPage(payload: unknown): GifSearchResponse {
  const data = (payload as { data?: { data?: unknown; has_next?: unknown } } | null)?.data;
  const rows = Array.isArray(data?.data) ? data.data : [];
  return {
    items: rows.map(mapItem).filter((i): i is KlipyItem => i !== null).map(toSearchItem),
    hasNext: data?.has_next === true,
  };
}

// ─── public surface ─────────────────────────────────────────────────────────

/** `'off'` means "send no rating param at all" (docs/GIFS.md §9, D9). */
function ratingParam(rating: GifRating): string | undefined {
  return rating === 'off' ? undefined : rating;
}

export async function searchGifs(query: string, page: number, rating: GifRating): Promise<GifSearchResponse> {
  return mapPage(await fetchJson(apiUrl('gifs/search', { q: query, page, per_page: GifLimits.perPage, rating: ratingParam(rating) })));
}

export async function trendingGifs(page: number, rating: GifRating): Promise<GifSearchResponse> {
  return mapPage(await fetchJson(apiUrl('gifs/trending', { page, per_page: GifLimits.perPage, rating: ratingParam(rating) })));
}

/**
 * Single item by slug — the resolver's entry point (docs/GIFS.md §7).
 *
 * ⚠️ **Search results carry a per-response suffix on the slug** (measured
 * 2026-08-13): every item in one response shares the same `--kUCiOZb1O` tail,
 * and it changes between responses — an analytics/share token, not part of the
 * item's identity. Both the suffixed and the canonical form resolve here, but
 * the returned `data.slug` is always the **canonical** one, and that is what
 * the caller stores. So we never regex the suffix off (a real slug could
 * legitimately contain `--`), and we never persist a session artifact into
 * `embeds.provider_ref` where it would outlive its own meaning.
 *
 * The numeric `id` field is NOT a usable lookup key — `gifs/{id}` 404s.
 */
export async function gifBySlug(slug: string): Promise<KlipyItem | null> {
  if (!isValidGifSlug(slug)) return null;
  const payload = await fetchJson(apiUrl(`gifs/${slug}`, {}), true);
  // Deleted, renamed, or never existed — all indistinguishable from here, and
  // all mean the same thing to every caller: there is no such GIF.
  if (payload === NOT_FOUND) return null;
  return mapItem((payload as { data?: unknown } | null)?.data);
}

/** The item's page on klipy.com. Built from the canonical slug — the only
 *  user-facing URL a picked GIF has, used for the failure fallback. */
export function klipyPageUrl(canonicalSlug: string): string {
  return `https://klipy.com/gifs/${canonicalSlug}`;
}
