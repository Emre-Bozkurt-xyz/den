import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { GalleryItem, GalleryResponse, MediaKind } from '@den/shared';
import { fetchAlbums, fetchGalleryPage } from '../lib/gallery';

export function useAlbums() {
  return useQuery({ queryKey: ['gallery', 'albums'], queryFn: fetchAlbums });
}

/** Keyset-paginated per-chat gallery (BACKBONE §5/§6), newest-first per page
 *  — mirrors useMessages. Refetches on type/query change via the query key. */
export function useGallery(chatId: string, kind: MediaKind | null, query: string) {
  return useInfiniteQuery({
    queryKey: ['gallery', chatId, kind, query] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) => fetchGalleryPage(chatId, kind, query, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: GalleryResponse) => lastPage.nextCursor,
  });
}

export function flattenGallery(pages: GalleryResponse[] | undefined): GalleryItem[] {
  if (!pages) return [];
  return pages.flatMap((p) => p.items);
}
