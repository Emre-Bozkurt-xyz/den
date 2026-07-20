import type { GalleryAlbumsResponse, GalleryResponse, MediaKind } from '@den/shared';
import { api } from './api';

export function fetchAlbums(): Promise<GalleryAlbumsResponse> {
  return api<GalleryAlbumsResponse>('/api/gallery/albums');
}

export function fetchGalleryPage(
  chatId: string,
  kind: MediaKind | null,
  query: string,
  before: string | null,
): Promise<GalleryResponse> {
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (query.trim()) params.set('q', query.trim());
  if (before) params.set('before', before);
  const qs = params.toString();
  return api<GalleryResponse>(`/api/chats/${chatId}/gallery${qs ? `?${qs}` : ''}`);
}
