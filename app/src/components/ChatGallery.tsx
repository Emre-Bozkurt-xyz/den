import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CheckSquare, ChevronDown, ChevronUp, Play, X } from 'lucide-react';
import type { GalleryAlbum, GalleryItem, GalleryKindFilter, MeResponse, Tag } from '@den/shared';
import { flattenGallery, useGallery } from '../hooks/useGallery';
import { useElementWidth } from '../hooks/useElementWidth';
import { useIsMobile } from '../hooks/useIsMobile';
import { chatDisplayName } from '../lib/chats';
import { formatDayLabel, formatTime, isSameCalendarDay } from '../lib/datetime';
import { useBackHandler } from '../lib/backStack';
import { computeMasonryLayout, galleryColumnCount, type MasonryLayout } from '../lib/masonry';
import { addTag, removeTag } from '../lib/tags';
import { MediaViewer, TagEditor } from './MediaViewer';
import { ScreenHeader } from './ScreenHeader';
import { TagSearchInput } from './TagSearchInput';
import { VoiceMessage } from './VoiceMessage';

const GRID_GAP = 12; // px — mosaic-style presentation retune (stage 1 of the gallery visual rework), up from the original cramped 2px

// Multi-select (BACKBONE §15 2026-07-22, stage 5 of the gallery rework) reuses
// ChatView's exact long-press timing/slop (docs/archive/MESSAGE_DELETE.md §4) so the
// gesture feels identical across the app's two selection-mode surfaces.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/** Tags common to every item in `items` — the batch tag panel edits this
 *  intersection, not any single item's tags (BACKBONE §15 2026-07-22).
 *  Matched by tag id (the per-chat tag registry is shared, so the same tag
 *  name always resolves to the same id across every selected item). */
function computeTagIntersection(items: GalleryItem[]): Tag[] {
  if (items.length === 0) return [];
  const [first, ...rest] = items;
  return first!.tags.filter((tag) => rest.every((item) => item.tags.some((t) => t.id === tag.id)));
}

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
 *  grid (docs/archive/UI_REVAMP.md UI-5 — shortest-column packing, aspect ratio
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
  const isMobile = useIsMobile();
  const [segment, setSegment] = useState<Segment>('media');
  const [mediaFilter, setMediaFilter] = useState<MediaSubFilter>('visual');
  const [query, setQuery] = useState('');
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [expandedVoiceId, setExpandedVoiceId] = useState<string | null>(null);

  // Multi-select tagging (BACKBONE §15 2026-07-22, stage 5) — Media segment
  // only (voice bubbles keep their existing per-item inline editor; joining
  // them to selection is Icebox, §13). Selection mode and the full-screen
  // viewer are mutually exclusive: entering one clears the other.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Mobile bottom sheet's compact/expanded state (§15 2026-07-22) — resets
  // whenever selection mode exits so re-entering always starts compact.
  const [sheetExpanded, setSheetExpanded] = useState(false);
  // System back gesture / browser back exits selection mode first, same
  // pattern and priority as ChatView's message multi-select.
  useBackHandler(selectionMode, () => exitSelectionMode());
  // Long-press bookkeeping — a plain timer with move-slop cancellation,
  // identical shape to ChatView's (docs/archive/MESSAGE_DELETE.md §4).
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
  // Set when the long-press timer fires, so the click that follows the
  // eventual pointerup (touch synthesizes one even after a long hold) is
  // swallowed instead of also toggling selection or opening the viewer.
  const suppressClickRef = useRef(false);

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
  // Selection mode is cleared here too (BACKBONE §15 2026-07-22) — a
  // selection made under one filter/query has no meaning under another.
  useEffect(() => {
    setViewerIndex(null);
    setExpandedVoiceId(null);
    exitSelectionMode();
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

  // Selected ids that no longer appear in the current (refetched/paginated)
  // `gridItems` are pruned rather than left dangling (BACKBONE §15
  // 2026-07-22) — e.g. a tag edit elsewhere changing what a query matches.
  // Returns the same Set instance when nothing changed so this never causes
  // an extra render loop even though `gridItems` is a fresh array every render.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(gridItems.map((item) => item.media.id));
      const next = new Set<string>();
      let changed = false;
      prev.forEach((id) => {
        if (validIds.has(id)) next.add(id);
        else changed = true;
      });
      if (!changed) return prev;
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  }, [gridItems]);

  // The selected items themselves (for the tag panel's thumbnail strip) and
  // the tag intersection across them (for the batch tag editor) — both pure
  // derivations of gridItems + selectedIds, so they always reflect whatever
  // the gallery query most recently returned (no separate cache to keep in
  // sync — CLAUDE.md hard invariant 3, server/query data is the truth).
  const selectedItems = useMemo(
    () => gridItems.filter((item) => selectedIds.has(item.media.id)),
    [gridItems, selectedIds],
  );
  const selectedTagIntersection = useMemo(() => computeTagIntersection(selectedItems), [selectedItems]);

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

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedIds(new Set());
    setSheetExpanded(false);
  }

  /** Long-press (mobile) or ctrl/cmd-click (desktop) on a tile — selects
   *  that one tile and enters selection mode. Also closes the viewer, since
   *  selection mode and the full-screen viewer are mutually exclusive. */
  function enterSelectionMode(mediaId: string) {
    setSelectionMode(true);
    setSelectedIds(new Set([mediaId]));
    setViewerIndex(null);
  }

  /** Desktop's "Select" toggle — enters selection mode with nothing selected
   *  yet (the user then taps tiles to build the selection), or exits it. */
  function toggleSelectionMode() {
    if (selectionMode) exitSelectionMode();
    else {
      setSelectionMode(true);
      setViewerIndex(null);
    }
  }

  /** Toggles one tile's membership in the selection. Deselecting the last
   *  remaining item exits selection mode entirely (BACKBONE §15 2026-07-22
   *  "exiting: ... or deselecting the last item") — reused by both grid tile
   *  taps and the tag panel's per-thumbnail remove button. */
  function toggleSelect(mediaId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) {
        next.delete(mediaId);
        if (next.size === 0) setSelectionMode(false);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  }

  function clearLongPressTimer() {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  function onTilePointerDown(e: React.PointerEvent, mediaId: string) {
    suppressClickRef.current = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressStartRef.current = { x: e.clientX, y: e.clientY };
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      suppressClickRef.current = true;
      if (selectionMode) toggleSelect(mediaId);
      else enterSelectionMode(mediaId);
    }, LONG_PRESS_MS);
  }

  function onTilePointerMove(e: React.PointerEvent) {
    const start = longPressStartRef.current;
    if (!start || longPressTimerRef.current === null) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > LONG_PRESS_SLOP_PX) clearLongPressTimer();
  }

  function onTilePointerUp() {
    clearLongPressTimer();
    longPressStartRef.current = null;
  }

  function onTilePointerCancel() {
    // Browser-interrupted gesture (e.g. an edge-swipe took over) — abort
    // with no side effects, same posture as MediaViewer/ChatView's handlers.
    clearLongPressTimer();
    longPressStartRef.current = null;
  }

  function onTileClick(e: React.MouseEvent, mediaId: string, globalIndex: number) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (selectionMode) {
      toggleSelect(mediaId);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      enterSelectionMode(mediaId);
      return;
    }
    setViewerIndex(globalIndex);
  }

  /** Batch tag ops (BACKBONE §15 2026-07-22): a client-side loop over the
   *  existing per-media endpoints, not a new batch API surface — friend-
   *  circle scale doesn't warrant one. `Promise.allSettled` so one failing
   *  item doesn't stop the rest; on any failure there's no special recovery,
   *  the post-batch `invalidateGallery` refetch just lets server truth win
   *  (CLAUDE.md hard invariant 3). */
  function batchAddTag(name: string) {
    const ids = Array.from(selectedIds);
    void Promise.allSettled(ids.map((id) => addTag(id, name))).then(invalidateGallery);
  }

  function batchRemoveTag(tagId: string) {
    const ids = Array.from(selectedIds);
    void Promise.allSettled(ids.map((id) => removeTag(id, tagId))).then(invalidateGallery);
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
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex flex-1 gap-1 overflow-x-auto">
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
          {/* Desktop-only entry point into selection mode (BACKBONE §15
              2026-07-22) — mobile uses long-press instead, matching
              ChatView's convention that mobile multi-select is never a
              standing toggle button. */}
          {!isMobile && (
            <button
              onClick={toggleSelectionMode}
              className={
                'flex shrink-0 items-center gap-1 rounded-pill px-3 py-1 text-xs font-medium transition-colors ' +
                (selectionMode ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-surface-sunken text-text-secondary')
              }
              style={{ touchAction: 'manipulation' }}
            >
              <CheckSquare size={13} />
              {selectionMode ? 'Cancel' : 'Select'}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div className={'flex-1 overflow-y-auto' + (isMobile && selectionMode && selectedItems.length > 0 ? ' pb-44' : '')}>
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
                        const isSelected = selectedIds.has(item.media.id);
                        return (
                          <button
                            key={item.media.id}
                            onClick={(e) => onTileClick(e, item.media.id, globalIndex)}
                            onPointerDown={(e) => onTilePointerDown(e, item.media.id)}
                            onPointerMove={onTilePointerMove}
                            onPointerUp={onTilePointerUp}
                            onPointerCancel={onTilePointerCancel}
                            className={
                              'gallery-tile animate-gallery-tile-in absolute overflow-hidden rounded-xl border bg-surface-sunken ' +
                              (isSelected ? 'border-accent ring-2 ring-accent' : 'border-border')
                            }
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
                            {isSelected && (
                              <span className="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-pill bg-accent text-white">
                                <Check size={12} />
                              </span>
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

        {/* Desktop right-side tag panel (BACKBONE §15 2026-07-22) — appears
            whenever the selection is non-empty, sitting inside the same
            flex row as the scrollable grid so its own width is subtracted
            from `useElementWidth`'s measurement and the masonry recomputes
            automatically. Mobile gets a bottom sheet instead — see below. */}
        {!isMobile && segment === 'media' && selectionMode && selectedItems.length > 0 && (
          <DesktopTagPanel
            chatId={album.chatId}
            items={selectedItems}
            tags={selectedTagIntersection}
            onAddTag={batchAddTag}
            onRemoveTag={batchRemoveTag}
            onRemoveItem={toggleSelect}
            onClose={exitSelectionMode}
          />
        )}
      </div>

      {isMobile && segment === 'media' && selectionMode && selectedItems.length > 0 && (
        <MobileTagSheet
          chatId={album.chatId}
          items={selectedItems}
          tags={selectedTagIntersection}
          expanded={sheetExpanded}
          onToggleExpanded={() => setSheetExpanded((v) => !v)}
          onAddTag={batchAddTag}
          onRemoveTag={batchRemoveTag}
          onRemoveItem={toggleSelect}
          onClose={exitSelectionMode}
        />
      )}

      {!selectionMode && viewerItem && (
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

/** Small removable-from-selection thumbnail, shared shape between the
 *  desktop panel's wrapping mini-grid and the mobile sheet's horizontal
 *  strip (BACKBONE §15 2026-07-22) — both use the same ~56px square. */
function SelectionThumb({ item, onRemove }: { item: GalleryItem; onRemove: () => void }) {
  return (
    <button
      onClick={onRemove}
      aria-label="Remove from selection"
      className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken"
      style={{ touchAction: 'manipulation' }}
    >
      <img src={item.media.thumbUrl ?? item.media.url ?? undefined} alt="" className="h-full w-full object-cover" />
      {/* Always visible on touch (no hover on mobile); desktop gets the same
          badge but it's a small enough affordance that always-on reads
          fine there too — not worth a second isMobile branch just for a
          hover-reveal. */}
      <span className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-pill bg-black/70 text-white">
        <X size={10} />
      </span>
    </button>
  );
}

type TagPanelProps = {
  chatId: string;
  items: GalleryItem[];
  tags: Tag[];
  onAddTag: (name: string) => void;
  onRemoveTag: (tagId: string) => void;
  onRemoveItem: (mediaId: string) => void;
  onClose: () => void;
};

/** Desktop's right-side batch tag panel (BACKBONE §15 2026-07-22) — full
 *  height of the gallery's content area (it's a flex sibling of the
 *  scrollable grid, see the call site), its own scroll, ~320px wide.
 *  `TagEditor` is reused as-is rather than forked: its chip list already
 *  shows/removes tags with the same debounced autocomplete the search bar
 *  uses, and it has no idea it's editing a batch instead of one item —
 *  `onAddTag`/`onRemoveTag` here just fan each call out to every selected
 *  item instead of one. Wrapped in the same dark inset panel the voice
 *  segment's per-item `TagEditor` already uses (BACKBONE §15 2026-07-22,
 *  see that call site's comment) since `TagEditor`'s literal-dark internals
 *  are built for `MediaViewer`'s always-dark backdrop, not this light
 *  surface. */
function DesktopTagPanel({ chatId, items, tags, onAddTag, onRemoveTag, onRemoveItem, onClose }: TagPanelProps) {
  return (
    <div className="flex w-80 shrink-0 flex-col border-l border-border bg-surface-raised">
      <div className="flex items-center gap-2 border-b border-border px-3 py-3">
        <span className="flex-1 text-sm font-semibold text-text-primary">{items.length} selected</span>
        <button
          onClick={onClose}
          aria-label="Clear selection"
          className="flex shrink-0 items-center text-text-secondary"
          style={{ touchAction: 'manipulation' }}
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-3 flex flex-wrap gap-2">
          {items.map((item) => (
            <SelectionThumb key={item.media.id} item={item} onRemove={() => onRemoveItem(item.media.id)} />
          ))}
        </div>
        <div className="rounded-md border border-border/40 bg-neutral-900 p-3">
          <TagEditor chatId={chatId} tags={tags} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />
        </div>
      </div>
    </div>
  );
}

/** Mobile's bottom-sheet counterpart to `DesktopTagPanel` — pinned above
 *  whatever's below it in the gallery screen with plain fixed positioning
 *  (BACKBONE §15 2026-07-22 judgment call: this is gallery chrome, not a
 *  reusable overlay, so no portal is needed — the mobile `chatGallery` view
 *  is already a full-screen route with no bottom tab bar sibling to clear,
 *  see `App.tsx`, so only the safe-area inset needs respecting, not a
 *  second nav-bar height). Compact (default) height is deliberately
 *  *not* height-capped: `TagEditor`'s autocomplete dropdown renders as an
 *  absolutely-positioned sibling that pops up from the input, and clipping
 *  the wrapper to force a hard "one row" cap would clip that dropdown too.
 *  Natural content height already reads as compact for the common case (a
 *  handful of tags); "expand" instead exists for the case where the
 *  intersection is large, giving that content explicit scroll room inside
 *  a bounded ~70dvh sheet rather than letting the sheet grow over the grid
 *  indefinitely. */
function MobileTagSheet({
  chatId,
  items,
  tags,
  expanded,
  onToggleExpanded,
  onAddTag,
  onRemoveTag,
  onRemoveItem,
  onClose,
}: TagPanelProps & { expanded: boolean; onToggleExpanded: () => void }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl border-t border-border bg-surface-raised shadow-strong"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)', maxHeight: expanded ? '70dvh' : undefined }}
    >
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span className="flex-1 text-sm font-semibold text-text-primary">{items.length} selected</span>
        <button
          onClick={onToggleExpanded}
          aria-label={expanded ? 'Collapse tag panel' : 'Expand tag panel'}
          className="flex shrink-0 items-center text-text-secondary"
          style={{ touchAction: 'manipulation' }}
        >
          {expanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button>
        <button
          onClick={onClose}
          aria-label="Clear selection"
          className="flex shrink-0 items-center text-text-secondary"
          style={{ touchAction: 'manipulation' }}
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto px-3 pb-2">
        {items.map((item) => (
          <SelectionThumb key={item.media.id} item={item} onRemove={() => onRemoveItem(item.media.id)} />
        ))}
      </div>
      <div className={'px-3 pb-3 ' + (expanded ? 'flex-1 overflow-y-auto' : '')}>
        <div className="rounded-md border border-border/40 bg-neutral-900 p-3">
          <TagEditor chatId={chatId} tags={tags} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />
        </div>
      </div>
    </div>
  );
}
