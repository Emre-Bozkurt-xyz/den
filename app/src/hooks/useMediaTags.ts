import { useQuery } from '@tanstack/react-query';
import { fetchMediaTags } from '../lib/tags';

/** Tags for a single media item, for the chat-side full-screen viewer.
 *  Disabled until a media id exists so the hook can sit at the top of
 *  `ChatView` (rules of hooks) while the viewer itself is closed. Kept under
 *  its own `['mediaTags', …]` key rather than `['gallery', …]` so the WS
 *  tag.added/tag.removed invalidation can target both (lib/realtime.tsx). */
export function useMediaTags(mediaId: string | null) {
  return useQuery({
    queryKey: ['mediaTags', mediaId] as const,
    queryFn: () => fetchMediaTags(mediaId!),
    enabled: mediaId !== null,
  });
}
