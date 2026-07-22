import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import type { GalleryAlbum, GalleryItem, GalleryKindFilter, MeResponse } from '@den/shared';
import { flattenGallery, useGallery } from '../hooks/useGallery';
import { useElementWidth } from '../hooks/useElementWidth';
import { chatDisplayName } from '../lib/chats';
import { formatDayLabel, formatTime, isSameCalendarDay } from '../lib/datetime';
import { computeMasonryLayout, galleryColumnCount, type MasonryLayout } from '../lib/masonry';
import { addTag, removeTag } from '../lib/tags';
import { MediaViewer, TagEditor } from './MediaViewer';
import { ScreenHeader } from './ScreenHeader';
import { TagSearchInput } from './TagSearchInput';
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

/** One calendar day's worth of gallery items, in their original (newest-
 *  first) order, plus the header/divider label for that day. */
interface DaySection {
  label: string;
  items: GalleryItem[];
}

/** Buckets an already newest-first `GalleryItem[]` into calendar-day runs
 *  (BACKBONE §15 2026-07-22 — always-on date grouping, both gallery
 *  segments). Items are contiguous per day by construction (the list is
 *  sorted by `createdAt` server-side), so a single linear pass comparing
 *  each item to the current bucket's day is enough — no sort, no bucket
 *  lookup by key. Recomputing this from the flattened array on every
 *  render (memoized by the caller) is what makes pagination "just work":
 *  a newly-appended older page either grows the last section or starts new
 *  ones, with no incremental cache to invalidate. */
function groupItemsByDay(items: GalleryItem[]): DaySection[] {
  const sections: DaySection[] = [];
  for (const item of items) {
    const current = sections[sections.length - 1];
    if (current && isSameCalendarDay(current.items[0]!.createdAt, item.createdAt)) {
      current.items.push(item);
    } else {
      sections.push({ label: formatDayLabel(item.createdAt), items: [item] });
    }
  }
  return sections;
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

  // Global index of each item within the flattened, newest-first `gridItems`
  // array — the day sections below only change how tiles are *drawn*; the
  // full-screen viewer's prev/next still steps through the whole array
  // across section boundaries, so every rendered tile needs to map back to
  // its position in the unsectioned list.
  const gridItemIndex = useMemo(() => {
    const map = new Map<string, number>();
    gridItems.forEach((item, i) => map.set(item.media.id, i));
    return map;
  }, [gridItems]);

  const [gridRef, gridWidth] = useElementWidth<HTMLDivElement>();
  const columnCount = galleryColumnCount(gridWidth);
  // One masonry layout per calendar day (BACKBONE §15 2026-07-22) — each day
  // restarts its own shortest-column packing rather than one grid spanning
  // the whole segment, so a day boundary is a real visual break, not just an
  // inline label. All sections share the single measured `gridWidth` and
  // `columnCount` from the common wrapper below.
  const daySections: (DaySection & MasonryLayout)[] = useMemo(
    () =>
      groupItemsByDay(gridItems).map((section) => ({
        ...section,
        ...computeMasonryLayout(
          section.items.map((item) => ({ id: item.media.id, width: item.media.width, height: item.media.height })),
          gridWidth,
          columnCount,
          GRID_GAP,
        ),
      })),
    [gridItems, gridWidth, columnCount],
  );

  const voiceDaySections = useMemo(() => groupItemsByDay(voiceItems), [voiceItems]);

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
        <TagSearchInput
          chatId={album.chatId}
          value={query}
          onChange={setQuery}
          placeholder="Search tags — beach -screenshots"
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
            <div ref={gridRef} className="flex flex-col gap-5">
              {daySections.map((section) => (
                <div key={section.items[0]!.media.id}>
                  <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    {section.label}
                  </h2>
                  <div className="relative" style={{ height: section.containerHeight }}>
                    {section.items.map((item, i) => {
                      const tile = section.tiles[i];
                      const globalIndex = gridItemIndex.get(item.media.id);
                      if (!tile || globalIndex === undefined) return null;
                      return (
                        <button
                          key={item.media.id}
                          onClick={() => setViewerIndex(globalIndex)}
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
              ))}
            </div>
          </div>
        )}

        {segment === 'voice' && voiceItems.length > 0 && (
          // Capped + centered on wide desktop panes (BACKBONE §15 2026-07-22)
          // — full-width chat bubbles on a 1400px gallery pane look wrong;
          // the chat view itself never gets that wide.
          <div className="mx-auto flex max-w-[640px] flex-col gap-4 p-3">
            {voiceDaySections.map((section) => (
              <div key={section.items[0]!.media.id} className="flex flex-col gap-4">
                {/* Same centered-muted-label treatment as ChatView's TimelineDivider
                    (UI-8b) — the day label now carries the date, so the per-item
                    caption below can drop back to a plain time (see formatTime use
                    below, BACKBONE §15 2026-07-22). */}
                <div className="flex justify-center py-1">
                  <span className="text-xs text-text-muted">{section.label}</span>
                </div>
                {section.items.map((item) => {
                  const mine = item.senderId === me.id;
                  const senderName = album.members.find((mem) => mem.id === item.senderId)?.displayName ?? 'Unknown';
                  const expanded = expandedVoiceId === item.media.id;
                  return (
                    <div
                      key={item.media.id}
                      className={
                        'flex max-w-[78%] flex-col gap-1 ' + (mine ? 'items-end self-end' : 'items-start self-start')
                      }
                    >
                      {album.isGroup && !mine && (
                        <p className="px-1 pb-0.5 text-xs font-semibold text-text-secondary">{senderName}</p>
                      )}

                      {/* Same bubble classes as ChatView's voice bubble (isRunHead, single block) — kept
                          identical so the gallery's voice list and the real chat view stay visually
                          indistinguishable. */}
                      <div
                        className={
                          'max-w-full rounded-lg px-2 py-1.5 text-sm ' +
                          (mine
                            ? 'rounded-br-[4px] bg-accent text-white'
                            : 'rounded-bl-[4px] bg-surface-sunken text-text-primary')
                        }
                      >
                        <VoiceMessage media={item.media} />
                      </div>

                      {/* Caption row is gallery chrome, deliberately outside the bubble.
                          Time-only, not `formatSendTime` — the section divider above
                          already carries the date, so repeating it here (e.g. "Jul 12,
                          4:23 PM" on every bubble) would be redundant on every item
                          except today's (judgment call, BACKBONE §15 2026-07-22). */}
                      <div className="flex items-center gap-2 px-1 text-xs text-text-muted">
                        <span>{formatTime(item.createdAt)}</span>
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
          onAddTag={(tagName) => void addTag(viewerItem.media.id, tagName).then(invalidateGallery)}
          onRemoveTag={(tagId) => void removeTag(viewerItem.media.id, tagId).then(invalidateGallery)}
        />
      )}
    </div>
  );
}
