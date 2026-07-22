import type { GalleryAlbum, MeResponse } from '@den/shared';
import { useAlbums } from '../hooks/useGallery';
import { useElementWidth } from '../hooks/useElementWidth';
import { chatDisplayName } from '../lib/chats';
import { albumColumnCount } from '../lib/masonry';

/** Top-level Gallery tab: chats-as-albums grid, cover = latest ready media's
 *  thumb (BACKBONE §9). Chats with zero media are omitted server-side.
 *
 *  Deliberately square/uniform tiles, not masonry (docs/archive/UI_REVAMP.md UI-5):
 *  `GalleryAlbum` (shared/src/api.ts) carries no width/height for
 *  `coverThumbUrl` — unlike `GalleryItem.media`, an album cover has no real
 *  aspect ratio to predict, so masonry's entire point (packing real photo
 *  proportions without pop-in) doesn't apply here. An album tile is also a
 *  cover (with an item-count chip overlaid) plus a name footer, i.e. more
 *  like a consistent app/folder icon than organic photo content, so forcing
 *  every cover to one shape keeps the grid scannable. Only the column count
 *  is responsive, tracking the same measured-container-width approach as the
 *  masonry grid. Card language (rounded/bordered, hover raise, entrance
 *  fade) matches the media grid — see `.gallery-tile` and
 *  `.animate-gallery-tile-in` in index.css (mosaic-style presentation
 *  retune, stage 1 of the gallery visual rework). */
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
                className="gallery-tile animate-gallery-tile-in overflow-hidden rounded-xl border border-border bg-surface-raised text-left"
                style={{ touchAction: 'manipulation' }}
              >
                <div className="relative aspect-square bg-surface-sunken">
                  {album.coverThumbUrl && (
                    <img src={album.coverThumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                  )}
                  <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
                    {album.mediaCount} item{album.mediaCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-semibold text-text-primary">{name}</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
