import { useEffect, useState } from 'react';
import type { MediaInfo, Tag } from '@den/shared';
import { fetchTagAutocomplete } from '../lib/tags';

/** Full-screen viewer for a ready image/video. Voice messages render inline
 *  in the chat (§7: "row-style list items", not thumbnails) and never open
 *  this. `onPrev`/`onNext` (gallery only) step through the current filtered
 *  result set; `onJumpToMessage` (gallery only) navigates back to the chat.
 *  Tag list + add/remove UI (§9) only renders when `tags` is passed — the
 *  ChatView usage (tapping a bubble) doesn't wire it, only ChatGallery does. */
export function MediaViewer({
  media,
  onClose,
  onPrev,
  onNext,
  onJumpToMessage,
  chatId,
  tags,
  onAddTag,
  onRemoveTag,
}: {
  media: MediaInfo;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onJumpToMessage?: () => void;
  chatId?: string;
  tags?: Tag[];
  onAddTag?: (name: string) => void;
  onRemoveTag?: (tagId: string) => void;
}) {
  if (media.status !== 'ready' || !media.url) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-lg text-white"
        style={{ top: 'calc(env(safe-area-inset-top) + 1rem)', touchAction: 'manipulation' }}
      >
        ✕
      </button>

      {onJumpToMessage && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onJumpToMessage();
          }}
          className="absolute left-4 top-4 rounded-full bg-white/10 px-3 py-1.5 text-sm text-white"
          style={{ top: 'calc(env(safe-area-inset-top) + 1rem)', touchAction: 'manipulation' }}
        >
          Jump to message
        </button>
      )}

      {onPrev && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label="Previous"
          className="absolute left-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-xl text-white"
          style={{ touchAction: 'manipulation' }}
        >
          ‹
        </button>
      )}
      {onNext && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="Next"
          className="absolute right-2 top-1/2 grid h-10 w-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-xl text-white"
          style={{ touchAction: 'manipulation' }}
        >
          ›
        </button>
      )}

      <div className="flex flex-1 items-center justify-center overflow-hidden">
        {media.kind === 'image' ? (
          <img
            src={media.url}
            alt=""
            className="max-h-full max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <video
            key={media.id}
            src={media.url}
            poster={media.thumbUrl ?? undefined}
            controls
            autoPlay
            className="max-h-full max-w-full"
            onClick={(e) => e.stopPropagation()}
          />
        )}
      </div>

      {tags && onAddTag && onRemoveTag && (
        <div onClick={(e) => e.stopPropagation()} className="shrink-0 bg-black/60 p-3">
          <TagEditor chatId={chatId} tags={tags} onAddTag={onAddTag} onRemoveTag={onRemoveTag} />
        </div>
      )}
    </div>
  );
}

export function TagEditor({
  chatId,
  tags,
  onAddTag,
  onRemoveTag,
}: {
  chatId: string | undefined;
  tags: Tag[];
  onAddTag: (name: string) => void;
  onRemoveTag: (tagId: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState<Tag[]>([]);

  useEffect(() => {
    if (!chatId || !draft.trim()) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void fetchTagAutocomplete(chatId, draft.trim()).then((res) => {
        if (!cancelled) setSuggestions(res.tags);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [chatId, draft]);

  function submit(name: string) {
    if (!name.trim()) return;
    onAddTag(name.trim());
    setDraft('');
    setSuggestions([]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t.id} className="flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-xs text-white">
            {t.name}
            <button onClick={() => onRemoveTag(t.id)} aria-label={`Remove tag ${t.name}`} className="text-white/60">
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="flex gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a tag — spaces become hyphens"
            className="min-w-0 flex-1 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1.5 text-sm text-white outline-none placeholder:text-white/40"
          />
          <button type="submit" disabled={!draft.trim()} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-40">
            Add
          </button>
        </form>
        {suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 mb-1 w-full overflow-hidden rounded-lg bg-neutral-900 shadow-lg">
            {suggestions.map((s) => (
              <button
                key={s.id}
                onClick={() => submit(s.name)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-white hover:bg-white/10"
              >
                <span>{s.name}</span>
                <span className="text-white/40">{s.usageCount}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
