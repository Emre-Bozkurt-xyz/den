import type { GalleryAlbum, MeResponse } from '@den/shared';
import { useAlbums } from '../hooks/useGallery';
import { chatDisplayName } from '../lib/chats';

/** Top-level Gallery tab: chats-as-albums grid, cover = latest ready media's
 *  thumb (BACKBONE §9). Chats with zero media are omitted server-side. */
export function GalleryScreen({ me, onOpenAlbum }: { me: MeResponse; onOpenAlbum: (album: GalleryAlbum) => void }) {
  const { data, isLoading } = useAlbums();

  return (
    <div>
      {isLoading && <p className="p-4 text-center text-sm text-neutral-400">Loading…</p>}
      {!isLoading && data?.albums.length === 0 && (
        <p className="p-6 text-center text-sm text-neutral-400">
          No media yet — send a photo, video, or voice message in a chat to see it here.
        </p>
      )}

      {data && data.albums.length > 0 && (
        <div className="grid grid-cols-2 gap-2 p-3">
          {data.albums.map((album) => {
            const name = chatDisplayName(album, me.id);
            return (
              <button
                key={album.chatId}
                onClick={() => onOpenAlbum(album)}
                className="overflow-hidden rounded-2xl border border-black/10 text-left dark:border-white/10"
                style={{ touchAction: 'manipulation' }}
              >
                <div className="aspect-square bg-black/5 dark:bg-white/5">
                  {album.coverThumbUrl && <img src={album.coverThumbUrl} alt="" className="h-full w-full object-cover" />}
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-semibold">{name}</p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">
                    {album.mediaCount} item{album.mediaCount === 1 ? '' : 's'}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
