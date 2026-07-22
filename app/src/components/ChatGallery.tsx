import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import type { GalleryAlbum, GalleryKindFilter, MeResponse } from '@den/shared';
import { flattenGallery, useGallery } from '../hooks/useGallery';
import { useElementWidth } from '../hooks/useElementWidth';
import { chatDisplayName } from '../lib/chats';
import { formatSendTime } from '../lib/datetime';
import { computeMasonryLayout, galleryColumnCount } from '../lib/masonry';
import { addTag, removeTag } from '../lib/tags';
import { MediaViewer, TagEditor } from './MediaViewer';
import { ScreenHeader } from './ScreenHeader';
import { VoiceMessage } from './VoiceMessage';

const GRID_GAP = 12; // px — mosaic-style presentation retune (stage 1 of the gallery visual rework), up from the original cramped 2px

/** Top-level gallery partition (BACKBONE §15 2026-07-22, supersedes the old
 *  All/Images/Videos/Voice tabs): Media (masonry grid, image+video) and
 *  Voice (a separate chat-skinned list) — mixing thumbnails and inline
 *  audio players in one feed never read well, and the two need genuinely
 *  different item chrome. */
type Segment = 'media' | 'voice';

/** Sub-filter inside the Media segment only. 'visual' (server `kind=visual`)
 *  is the segment's default — image OR video, i.e. everything the grid can
 *  show. */
type MediaSubFilter = Extract<GalleryKindFilter, 'visual' | 'image' | 'video'>;

const SEGMENTS: { value: Segment; label: string }[] = [
  { value: 'media', label: 'Media' },
  { value: 'voice', label: 'Voice' },
];

const MEDIA_SUBFILTERS: { value: MediaSubFilter; label: string }[] = [
  { value: 'visual', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
];

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Per-chat gallery (BACKBONE §9): Media segment is a hand-rolled masonry
 *  grid (docs/UI_REVAMP.md UI-5 — shortest-column packing, aspect ratio
 *  predicted from MediaInfo.width/height so there's no image-load pop-in);
 *  Voice segment is a chat-skinned list reusing the same bubble the chat
 *  view renders (BACKBONE §15 2026-07-22) — never a thumbnail. Tap a grid
 *  tile → the full-screen viewer with prev/next through the current
 *  filtered set, a jump-to-message shortcut, and tag add/remove. Search bar
 *  does a booru-style tag query (`beach -screenshots`, BACKBONE §5) and
 *  applies to whichever segment is active. Both segments stay newest-first
 *  — a deliberate gallery convention, not a mirror of the chat's
 *  oldest-first timeline (it's a costume, not a real chat). */
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
  const [segment, setSegment] = useState<Segment>('media');
  const [mediaFilter, setMediaFilter] = useState<MediaSubFilter>('visual');
  const [query, setQuery] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [expandedVoiceId, setExpandedVoiceId] = useState<string | null>(null);

  const kind: GalleryKindFilter = segment === 'voice' ? 'voice' : mediaFilter;
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useGallery(album.chatId, kind, query);
  const items = flattenGallery(data?.pages);
  const name = chatDisplayName(album, me.id);

  // Server already filters to exactly this segment's kind(s) — no client-side
  // re-filtering needed, unlike the old single "All" feed that mixed both.
  const gridItems = segment === 'media' ? items : [];
  const voiceItems = segment === 'voice' ? items : [];

  // A viewer index (or an expanded tag panel) from one segment/filter is
  // meaningless once the underlying item list changes out from under it.
  useEffect(() => {
    setViewerIndex(null);
    setExpandedVoiceId(null);
  }, [segment, mediaFilter, query]);

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

  const emptyMessage = query.trim()
    ? 'No media matches that tag search.'
    : segment === 'voice'
      ? 'No voice messages here yet.'
      : 'No media here yet.';

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

      <div className="flex gap-1 border-b border-border px-3 py-2">
        {SEGMENTS.map((s) => (
          <button
            key={s.value}
            onClick={() => setSegment(s.value)}
            className={
              'flex-1 rounded-pill px-3 py-1.5 text-sm font-semibold transition-colors ' +
              (segment === s.value ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-surface-sunken text-text-secondary')
            }
            style={{ touchAction: 'manipulation' }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {segment === 'media' && (
        <div className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2">
          {MEDIA_SUBFILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setMediaFilter(f.value)}
              className={
                'shrink-0 rounded-pill px-3 py-1 text-xs font-medium transition-colors ' +
                (mediaFilter === f.value ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-surface-sunken text-text-secondary')
              }
              style={{ touchAction: 'manipulation' }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-center text-sm text-text-muted">Loading…</p>}
        {!isLoading && items.length === 0 && <p className="p-6 text-center text-sm text-text-muted">{emptyMessage}</p>}

        {segment === 'media' && gridItems.length > 0 && (
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

        {segment === 'voice' && voiceItems.length > 0 && (
          // Capped + centered on wide desktop panes (BACKBONE §15 2026-07-22)
          // — full-width chat bubbles on a 1400px gallery pane look wrong;
          // the chat view itself never gets that wide.
          <div className="mx-auto flex max-w-[640px] flex-col gap-4 p-3">
            {voiceItems.map((item) => {
              const mine = item.senderId === me.id;
              const senderName = album.members.find((mem) => mem.id === item.senderId)?.displayName ?? 'Unknown';
              const expanded = expandedVoiceId === item.media.id;
              return (
                <div
                  key={item.media.id}
                  className={'flex max-w-[78%] flex-col gap-1 ' + (mine ? 'items-end self-end' : 'items-start self-start')}
                >
                  {album.isGroup && !mine && <p className="px-1 pb-0.5 text-xs font-semibold text-text-secondary">{senderName}</p>}

                  {/* Same bubble classes as ChatView's voice bubble (isRunHead, single block) — kept
                      identical so the gallery's voice list and the real chat view stay visually
                      indistinguishable. */}
                  <div
                    className={
                      'max-w-full rounded-lg px-2 py-1.5 text-sm ' +
                      (mine ? 'rounded-br-[4px] bg-accent text-white' : 'rounded-bl-[4px] bg-surface-sunken text-text-primary')
                    }
                  >
                    <VoiceMessage media={item.media} />
                  </div>

                  {/* Caption row is gallery chrome, deliberately outside the bubble. */}
                  <div className="flex items-center gap-2 px-1 text-xs text-text-muted">
                    <span>{formatSendTime(item.createdAt)}</span>
                    <button
                      onClick={() => setExpandedVoiceId((id) => (id === item.media.id ? null : item.media.id))}
                      className="text-indigo-600 dark:text-indigo-400"
                      style={{ touchAction: 'manipulation' }}
                    >
                      Tags ({item.tags.length})
                    </button>
                    <button
                      onClick={() => onJumpToMessage(item.chatId, item.messageId)}
                      className="text-indigo-600 dark:text-indigo-400"
                      style={{ touchAction: 'manipulation' }}
                    >
                      Jump
                    </button>
                  </div>

                  {expanded && (
                    // TagEditor's internals use hardcoded white/black-panel literal colors
                    // (designed for MediaViewer's always-dark backdrop, see its own doc
                    // comment) — here it sits on the app surface instead, so it's wrapped in
                    // its own dark inset panel rather than restyling TagEditor itself. A dark
                    // panel on an otherwise light page is an accepted tradeoff (judgment call,
                    // BACKBONE §15 2026-07-22); leaving TagEditor's fixed-dark internals as-is
                    // avoids a second, divergent color pass on a shared component.
                    <div className="w-full max-w-full rounded-md border border-border/40 bg-neutral-900 p-2 shadow-sm">
                      <TagEditor
                        chatId={album.chatId}
                        tags={item.tags}
                        onAddTag={(tagName) => void addTag(item.media.id, tagName).then(invalidateGallery)}
                        onRemoveTag={(tagId) => void removeTag(item.media.id, tagId).then(invalidateGallery)}
                      />
                    </div>
                  )}
                </div>
              );
            })}
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
          onAddTag={(tagName) => void addTag(viewerItem.media.id, tagName).then(invalidateGallery)}
          onRemoveTag={(tagId) => void removeTag(viewerItem.media.id, tagId).then(invalidateGallery)}
        />
      )}
    </div>
  );
}
