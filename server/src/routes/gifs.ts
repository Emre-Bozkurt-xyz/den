/**
 * GIF picker proxy (docs/GIFS.md §6). Two read-only routes that stand between
 * the client and Klipy so that:
 *
 *  1. the API key never leaves the server — Klipy puts it in the URL *path*,
 *     so any client-side call would leak it through request URLs, referrers
 *     and devtools (docs/GIFS.md §6);
 *  2. the client only ever sees the normalized `GifSearchItem`, which is what
 *     makes the provider swappable (§2 — Tenor's shutdown is why this feature
 *     exists at all);
 *  3. the per-user rating ceiling is applied server-side from the user's own
 *     settings row, never from a client-supplied parameter (§9 / D9).
 *
 * `requireAuth` on both: an unauthenticated stranger must not be able to burn
 * a shared, rate-limited key.
 */
import type { FastifyInstance } from 'fastify';
import { DEFAULT_USER_SETTINGS, GIF_RATINGS, GifLimits, type GifRating, type GifSearchResponse } from '@den/shared';
import { requireAuth } from '../auth/session.js';
import { validation } from '../errors.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { searchGifs, trendingGifs } from '../gifs/klipy.js';

/**
 * In-memory response cache (docs/GIFS.md §10). Not just a rate-limit dodge —
 * it is also what makes the picker feel instant when several people search the
 * same obvious term. Deliberately a plain Map rather than a dependency: single
 * process, bounded by `MAX_ENTRIES`, and nothing here is worth persisting.
 *
 * The rating is part of the key: two users on different ceilings must never
 * see each other's result set.
 */
interface CacheEntry {
  expiresAt: number;
  value: GifSearchResponse;
}
const cache = new Map<string, CacheEntry>();
const MAX_ENTRIES = 500;
const SEARCH_TTL_MS = 5 * 60 * 1000;
/** Trending changes slowly and is the picker's default view, so it earns a
 *  much longer TTL — this is the single most-requested call in the feature. */
const TRENDING_TTL_MS = 60 * 60 * 1000;

async function cached(key: string, ttlMs: number, load: () => Promise<GifSearchResponse>): Promise<GifSearchResponse> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const value = await load();
  // Evict oldest-inserted first (Map preserves insertion order). Crude, but a
  // real LRU would need touch-on-read bookkeeping for no practical gain at
  // this size.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

/** The acting user's ceiling, read from their own settings row — never from
 *  the request (§9). Falls back to the default for a row that predates the
 *  key, matching how `mergeUserSettings` treats stored settings. */
async function ratingFor(userId: bigint): Promise<GifRating> {
  const rows = await db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).limit(1);
  const stored = rows[0]?.settings as { gifRating?: unknown } | null | undefined;
  const value = stored?.gifRating;
  return typeof value === 'string' && (GIF_RATINGS as readonly string[]).includes(value)
    ? (value as GifRating)
    : DEFAULT_USER_SETTINGS.gifRating;
}

function parsePage(raw: unknown): number {
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw validation('invalid page');
  return n;
}

export async function gifRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string; page?: string } }>(
    '/gifs/search',
    { preHandler: requireAuth },
    async (req): Promise<GifSearchResponse> => {
      const q = (req.query.q ?? '').trim();
      if (q.length < GifLimits.minQueryLength) throw validation(`query must be at least ${GifLimits.minQueryLength} characters`);
      if (q.length > GifLimits.maxQueryLength) throw validation('query too long');
      const page = parsePage(req.query.page);
      const rating = await ratingFor(req.user!.id);

      return cached(`s|${rating}|${page}|${q.toLowerCase()}`, SEARCH_TTL_MS, () => searchGifs(q, page, rating));
    },
  );

  app.get<{ Querystring: { page?: string } }>(
    '/gifs/trending',
    { preHandler: requireAuth },
    async (req): Promise<GifSearchResponse> => {
      const page = parsePage(req.query.page);
      const rating = await ratingFor(req.user!.id);

      return cached(`t|${rating}|${page}`, TRENDING_TTL_MS, () => trendingGifs(page, rating));
    },
  );
}
