import type { GalleryAlbum, MeResponse } from '@den/shared';
import { useAlbums } from '../hooks/useGallery';
import { useElementWidth } from '../hooks/useElementWidth';
import { chatDisplayName } from '../lib/chats';
import { albumColumnCount } from '../lib/masonry';

/** Top-level Gallery tab: chats-as-albums grid, cover = latest ready media's
 *  thumb (BACKBONE §9). Chats with zero media are omitted server-side.
 *
 *  Deliberately square/uniform tiles, not masonry (docs/UI_REVAMP.md UI-5):
 *  `GalleryAlbum` (shared/src/api.ts) carries no width/height for
 *  `coverThumbUrl` — unlike `GalleryItem.media`, an album cover has no real
 *  aspect ratio to predict, so masonry's entire point (packing real photo
 *  proportions without pop-in) doesn't apply here. An album tile is also a
 *  cover + name + item-count footer, i.e. more like a consistent app/folder
 *  icon than organic photo content, so forcing every cover to one shape
 *  keeps the grid scannable. Only the column count is responsive, tracking
 *  the same measured-container-width approach as the masonry grid. */
export function GalleryScreen({ me, onOpenAlbum }: { me: MeResponse; onOpenAlbum: (album: GalleryAlbum) => void }) {
  const { data, isLoading } = useAlbums();
  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const columnCount = albumColumnCount(gridWidth);

  return (
    <div>
      {isLoading && <p className="p-4 text-center text-sm text-text-muted">Loading…</p>}
      {!isLoading && data?.albums.length === 0 && (
        <p className="p-6 text-center text-sm text-text-muted">
          No media yet — send a photo, video, or voice message in a chat to see it here.
        </p>
      )}

      {data && data.albums.length > 0 && (
        <div
          ref={gridRef}
          className="grid gap-2 p-3"
          style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
        >
          {data.albums.map((album) => {
            const name = chatDisplayName(album, me.id);
            return (
              <button
                key={album.chatId}
                onClick={() => onOpenAlbum(album)}
                className="overflow-hidden rounded-lg border border-border text-left transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
                style={{ touchAction: 'manipulation' }}
              >
                <div className="aspect-square bg-surface-sunken">
                  {album.coverThumbUrl && (
                    <img src={album.coverThumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
                  <p className="text-xs text-text-secondary">
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
