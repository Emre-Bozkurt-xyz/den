import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GalleryAlbum, MediaKind, MeResponse } from '@den/shared';
import { flattenGallery, useGallery } from '../hooks/useGallery';
import { chatDisplayName } from '../lib/chats';
import { addTag, removeTag } from '../lib/tags';
import { MediaViewer, TagEditor } from './MediaViewer';

type TypeFilter = 'all' | MediaKind;

const TABS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'voice', label: 'Voice' },
];

/** Per-chat gallery (BACKBONE §9): 3-column square grid for images/videos,
 *  voice as a separate row list (never a thumbnail). Tap a grid tile → the
 *  full-screen viewer with prev/next through the current filtered set, a
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

  function invalidateGallery() {
    void qc.invalidateQueries({ queryKey: ['gallery'] });
  }

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header
        className="flex items-center gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400" aria-label="Back">
          ← Back
        </button>
        <p className="truncate font-semibold">{name}</p>
      </header>

      <div className="border-b border-black/10 px-3 py-2 dark:border-white/10">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tags — beach -screenshots"
          className="w-full rounded-lg border border-black/10 bg-white px-3 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-white/15 dark:bg-neutral-900"
        />
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-black/10 px-3 py-2 dark:border-white/10">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setFilter(t.value)}
            className={
              'shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ' +
              (filter === t.value
                ? 'bg-indigo-600 text-white'
                : 'bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300')
            }
            style={{ touchAction: 'manipulation' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-center text-sm text-neutral-400">Loading…</p>}
        {!isLoading && items.length === 0 && (
          <p className="p-6 text-center text-sm text-neutral-400">
            {query.trim() ? 'No media matches that tag search.' : 'No media here yet.'}
          </p>
        )}

        {gridItems.length > 0 && (
          <div className="grid grid-cols-3 gap-0.5 p-0.5">
            {gridItems.map((item, i) => (
              <button
                key={item.media.id}
                onClick={() => setViewerIndex(i)}
                className="relative aspect-square overflow-hidden bg-black/5 dark:bg-white/5"
                style={{ touchAction: 'manipulation' }}
              >
                <img src={item.media.thumbUrl ?? item.media.url ?? undefined} alt="" className="h-full w-full object-cover" />
                {item.media.kind === 'video' && (
                  <span className="absolute inset-0 grid place-items-center bg-black/10">
                    <span className="grid h-8 w-8 place-items-center rounded-full bg-black/50 text-sm text-white">▶</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {voiceItems.length > 0 && (
          <div className="flex flex-col gap-2 p-3">
            {filter === 'all' && gridItems.length > 0 && (
              <p className="mt-1 text-xs font-semibold uppercase text-neutral-400">Voice messages</p>
            )}
            {voiceItems.map((item) => (
              <div key={item.media.id} className="flex flex-col gap-2 rounded-xl border border-black/10 p-2 dark:border-white/10">
                <div className="flex items-center gap-2">
                  <audio controls preload="metadata" src={item.media.url ?? undefined} className="h-10 flex-1" />
                  <button
                    onClick={() => setExpandedVoiceId((id) => (id === item.media.id ? null : item.media.id))}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs text-indigo-600 dark:text-indigo-400"
                    style={{ touchAction: 'manipulation' }}
                  >
                    Tags ({item.tags.length})
                  </button>
                  <button
                    onClick={() => onJumpToMessage(item.chatId, item.messageId)}
                    className="shrink-0 rounded-lg px-2 py-1 text-xs text-indigo-600 dark:text-indigo-400"
                    style={{ touchAction: 'manipulation' }}
                  >
                    Jump
                  </button>
                </div>
                {expandedVoiceId === item.media.id && (
                  <div className="rounded-lg bg-neutral-900 p-2">
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
              className="rounded-lg border border-black/10 px-3 py-1 text-xs text-neutral-500 dark:border-white/15 dark:text-neutral-400"
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
