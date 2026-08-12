import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { GalleryItem, GalleryKindFilter, GalleryResponse } from '@den/shared';
import { fetchAlbums, fetchGalleryPage } from '../lib/gallery';

export function useAlbums() {
  return useQuery({ queryKey: ['gallery', 'albums'], queryFn: fetchAlbums });
}

/** Keyset-paginated per-chat gallery (BACKBONE §5/§6), newest-first per page
 *  — mirrors useMessages. Refetches on type/query change via the query key. */
export function useGallery(chatId: string, kind: GalleryKindFilter | null, query: string) {
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

/** docs/GALLERY_FILMSTRIP.md §4 — the server sends `totalCount` on the FIRST
 *  page only (null thereafter), so read it off page 0 rather than the last
 *  page. Null until the first page lands; the filmstrip then falls back to
 *  "as many slots as we have items", which is correct, just not yet honest
 *  about the tail. */
export function galleryTotalCount(pages: GalleryResponse[] | undefined): number | null {
  return pages?.[0]?.totalCount ?? null;
}
