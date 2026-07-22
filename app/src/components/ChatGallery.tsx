import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import type { GalleryAlbum, MediaKind, MeResponse } from '@den/shared';
import { flattenGallery, useGallery } from '../hooks/useGallery';
import { useElementWidth } from '../hooks/useElementWidth';
import { chatDisplayName } from '../lib/chats';
import { computeMasonryLayout, galleryColumnCount } from '../lib/masonry';
import { addTag, removeTag } from '../lib/tags';
import { MediaViewer, TagEditor } from './MediaViewer';
import { ScreenHeader } from './ScreenHeader';

const GRID_GAP = 12; // px — mosaic-style presentation retune (stage 1 of the gallery visual rework), up from the original cramped 2px

type TypeFilter = 'all' | MediaKind;

const TABS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'voice', label: 'Voice' },
];

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Per-chat gallery (BACKBONE §9): hand-rolled masonry grid for images/videos
 *  (docs/UI_REVAMP.md UI-5 — shortest-column packing, aspect ratio predicted
 *  from MediaInfo.width/height so there's no image-load pop-in), voice as a
 *  separate row list (never a thumbnail). Tap a grid tile → the full-screen
 *  viewer with prev/next through the current filtered set, a
 *  jump-to-message shortcut, and tag add/remove. Search bar does a
 *  booru-style tag query (`beach -screenshots`, BACKBONE §5). */
export function ChatGallery({
  album,
  me,
  onBack,
  onJumpToMessage,
}: {
  album: GalleryAlbum;
  me: MeResponse;
  onBack: () => void;
  onJumpToMessage: (chatId: string, messageId: string) => void;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [expandedVoiceId, setExpandedVoiceId] = useState<string | null>(null);
  const kind = filter === 'all' ? null : filter;
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useGallery(album.chatId, kind, query);
  const items = flattenGallery(data?.pages);

  const gridItems = useMemo(() => items.filter((i) => i.media.kind !== 'voice'), [items]);
  const voiceItems = useMemo(() => items.filter((i) => i.media.kind === 'voice'), [items]);
  const name = chatDisplayName(album, me.id);

  const viewerItem = viewerIndex !== null ? gridItems[viewerIndex] : undefined;

  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const columnCount = galleryColumnCount(gridWidth);
  const { tiles, containerHeight } = useMemo(
    () =>
      computeMasonryLayout(
        gridItems.map((item) => ({ id: item.media.id, width: item.media.width, height: item.media.height })),
        gridWidth,
        columnCount,
        GRID_GAP,
      ),
    [gridItems, gridWidth, columnCount],
  );
  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t] as const)), [tiles]);

  function invalidateGallery() {
    void qc.invalidateQueries({ queryKey: ['gallery'] });
  }

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title={name} onBack={onBack} />

      <div className="border-b border-border px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags — beach -screenshots"
          className="w-full rounded-sm border border-border bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setFilter(t.value)}
            className={
              'shrink-0 rounded-pill px-3 py-1.5 text-sm font-medium transition-colors ' +
              (filter === t.value
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'bg-surface-sunken text-text-secondary')
            }
            style={{ touchAction: 'manipulation' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-center text-sm text-text-muted">Loading…</p>}
        {!isLoading && items.length === 0 && (
          <p className="p-6 text-center text-sm text-text-muted">
            {query.trim() ? 'No media matches that tag search.' : 'No media here yet.'}
          </p>
        )}

        {gridItems.length > 0 && (
          // Padding lives on this wrapper, outside the `gridRef`-measured div below,
          // so `useElementWidth` reports exactly the width tiles are laid out into —
          // padding here would otherwise be double-counted against the masonry math.
          <div className="p-3">
            <div ref={gridRef} className="relative" style={{ height: containerHeight }}>
              {gridItems.map((item, i) => {
                const tile = tileById.get(item.media.id);
                if (!tile) return null;
                return (
                  <button
                    key={item.media.id}
                    onClick={() => setViewerIndex(i)}
                    className="gallery-tile animate-gallery-tile-in absolute overflow-hidden rounded-xl border border-border bg-surface-sunken"
                    style={{
                      left: tile.left,
                      top: tile.top,
                      width: tile.width,
                      height: tile.height,
                      touchAction: 'manipulation',
                    }}
                  >
                    <img
                      src={item.media.thumbUrl ?? item.media.url ?? undefined}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                    {item.media.kind === 'video' && (
                      <>
                        <span className="absolute inset-0 grid place-items-center bg-black/10">
                          <span className="grid h-8 w-8 place-items-center rounded-pill bg-black/50 text-white">
                            <Play size={14} fill="currentColor" />
                          </span>
                        </span>
                        {item.media.durationMs != null && (
                          <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
                            {formatDuration(item.media.durationMs)}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {voiceItems.length > 0 && (
          <div className="flex flex-col gap-2 p-3">
            {filter === 'all' && gridItems.length > 0 && (
              <p className="mt-1 text-xs font-semibold uppercase text-text-muted">Voice messages</p>
            )}
            {voiceItems.map((item) => (
              <div key={item.media.id} className="flex flex-col gap-2 rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <audio controls preload="metadata" src={item.media.url ?? undefined} className="h-10 flex-1" />
                  <button
                    onClick={() => setExpandedVoiceId((id) => (id === item.media.id ? null : item.media.id))}
                    className="shrink-0 rounded-sm px-2 py-1 text-xs text-indigo-600 dark:text-indigo-400"
                    style={{ touchAction: 'manipulation' }}
                  >
                    Tags ({item.tags.length})
                  </button>
                  <button
                    onClick={() => onJumpToMessage(item.chatId, item.messageId)}
                    className="shrink-0 rounded-sm px-2 py-1 text-xs text-indigo-600 dark:text-indigo-400"
                    style={{ touchAction: 'manipulation' }}
                  >
                    Jump
                  </button>
                </div>
                {expandedVoiceId === item.media.id && (
                  <div className="rounded-sm bg-neutral-900 p-2">
                    <TagEditor
                      chatId={album.chatId}
                      tags={item.tags}
                      onAddTag={(name) => void addTag(item.media.id, name).then(invalidateGallery)}
                      onRemoveTag={(tagId) => void removeTag(item.media.id, tagId).then(invalidateGallery)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {hasNextPage && (
          <div className="flex justify-center p-3">
            <button
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="rounded-sm border border-border px-3 py-1 text-xs text-text-secondary hover:bg-surface-sunken"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {viewerItem && (
        <MediaViewer
          media={viewerItem.media}
          onClose={() => setViewerIndex(null)}
          onPrev={viewerIndex! > 0 ? () => setViewerIndex((i) => (i! > 0 ? i! - 1 : i)) : undefined}
          onNext={viewerIndex! < gridItems.length - 1 ? () => setViewerIndex((i) => (i! < gridItems.length - 1 ? i! + 1 : i)) : undefined}
          onJumpToMessage={() => onJumpToMessage(viewerItem.chatId, viewerItem.messageId)}
          chatId={album.chatId}
          tags={viewerItem.tags}
          onAddTag={(name) => void addTag(viewerItem.media.id, name).then(invalidateGallery)}
          onRemoveTag={(tagId) => void removeTag(viewerItem.media.id, tagId).then(invalidateGallery)}
        />
      )}
    </div>
  );
}
