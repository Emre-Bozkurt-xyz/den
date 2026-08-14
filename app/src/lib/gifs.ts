import type {
  GifFavorite,
  GifFavoriteKeysResponse,
  GifFavoritesResponse,
  GifSearchResponse,
} from '@den/shared';
import { api } from './api';

/**
 * GIF picker data access (docs/GIFS.md §6). Both routes are Den's own proxy —
 * the client never calls Klipy's API directly, because the key lives in the
 * URL path server-side. (The picker's *thumbnails* do come from Klipy's CDN,
 * which is D10's accepted exception and applies only while the panel is open.)
 */

export function fetchGifSearch(query: string, page: number): Promise<GifSearchResponse> {
  const params = new URLSearchParams({ q: query.trim() });
  if (page > 1) params.set('page', String(page));
  return api<GifSearchResponse>(`/api/gifs/search?${params.toString()}`);
}

export function fetchGifTrending(page: number): Promise<GifSearchResponse> {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  return api<GifSearchResponse>(`/api/gifs/trending${qs ? `?${qs}` : ''}`);
}

// ─── favorites (docs/GIF_FAVORITES.md §6) ───────────────────────────────────

export function fetchGifFavorites(before?: string | null): Promise<GifFavoritesResponse> {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  return api<GifFavoritesResponse>(`/api/gifs/favorites${qs}`);
}

/** Star state for every surface at once — see `useGifFavoriteKeys`. */
export function fetchGifFavoriteKeys(): Promise<GifFavoriteKeysResponse> {
  return api<GifFavoriteKeysResponse>('/api/gifs/favorites/keys');
}

/** `slug` may be suffixed (a search result) or canonical (a chat card or the
 *  favorites tab) — the server resolves either and stores the canonical form
 *  (docs/GIF_FAVORITES.md D-F3). */
export function addGifFavorite(slug: string): Promise<GifFavorite> {
  return api<GifFavorite>('/api/gifs/favorites', { method: 'POST', body: JSON.stringify({ slug }) });
}

/** Takes the CANONICAL slug only. A picker tile doesn't have one — it resolves
 *  `itemId → slug` through the keys list first (§6). */
export function removeGifFavorite(canonicalSlug: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/api/gifs/favorites/${encodeURIComponent(canonicalSlug)}`, { method: 'DELETE' });
}
