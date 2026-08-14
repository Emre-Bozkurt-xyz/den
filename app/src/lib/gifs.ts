import type { GifSearchResponse } from '@den/shared';
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
