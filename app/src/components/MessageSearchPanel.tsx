import { useRef } from 'react';
import { ArrowLeft, Image as ImageIcon, Mic, Video, X } from 'lucide-react';
import type { Message, MessageKind, PublicUser } from '@den/shared';
import {
  flattenSearchResults,
  hasSearchCriteria,
  useMessageSearch,
  type MessageSearchFilters,
  type SearchFormState,
} from '../hooks/useMessageSearch';
import { useBackHandler } from '../lib/backStack';
import { formatSendTime } from '../lib/datetime';

const MEDIA_KIND_LABEL: Record<Extract<MessageKind, 'image' | 'video' | 'voice'>, string> = {
  image: 'Photo',
  video: 'Video',
  voice: 'Voice message',
};

/** How far into a body a match has to sit before the snippet stops showing
 *  the raw start and instead windows around the match with a leading "…"
 *  (docs/MESSAGE_SEARCH.md §4.4) — roughly "more than the ~3 clamped lines
 *  would show anyway". */
const SNIPPET_MATCH_THRESHOLD = 180;
const SNIPPET_LOOKAROUND = 40; // chars of context kept before a distant match

/** Windows a long body around the first match so a match far past what
 *  `line-clamp-3` would ever render isn't silently invisible. Returns the
 *  raw body unchanged when there's no query, no match, or the match is
 *  already within the clamp's reach. */
function windowSnippet(body: string, query: string): { text: string; leadingEllipsis: boolean } {
  if (!query) return { text: body, leadingEllipsis: false };
  const idx = body.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0 || idx <= SNIPPET_MATCH_THRESHOLD) return { text: body, leadingEllipsis: false };
  return { text: body.slice(Math.max(0, idx - SNIPPET_LOOKAROUND)), leadingEllipsis: true };
}

/** Case-insensitive split of `text` on `query`, client-side only (§4.4: React
 *  text nodes, never `dangerouslySetInnerHTML`). */
function splitHighlight(text: string, query: string): { text: string; match: boolean }[] {
  if (!query) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const segments: { text: string; match: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      segments.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) segments.push({ text: text.slice(i, idx), match: false });
    segments.push({ text: text.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
  }
  return segments;
}

function KindGlyph({ kind }: { kind: MessageKind }) {
  if (kind === 'image') return <ImageIcon size={13} className="shrink-0 text-text-muted" />;
  if (kind === 'video') return <Video size={13} className="shrink-0 text-text-muted" />;
  if (kind === 'voice') return <Mic size={13} className="shrink-0 text-text-muted" />;
  return null;
}

function SearchResultRow({
  message,
  members,
  query,
  onJump,
}: {
  message: Message;
  members: PublicUser[];
  query: string;
  onJump: (id: string) => void;
}) {
  const sender = members.find((m) => m.id === message.senderId);
  const isMedia = message.kind !== 'text' && message.kind !== 'system';
  const rawBody = message.body ?? (isMedia ? MEDIA_KIND_LABEL[message.kind as 'image' | 'video' | 'voice'] : '');
  // Filter-only searches (no q) render the plain body — no highlight, no
  // windowing (§4.4).
  const { text, leadingEllipsis } = windowSnippet(rawBody, query);
  const segments = splitHighlight(text, query);

  return (
    <button
      onClick={() => onJump(message.id)}
      className="flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left hover:bg-surface-sunken"
      style={{ touchAction: 'manipulation' }}
    >
      <div className="flex items-baseline gap-2">
        <span className="truncate text-sm font-semibold text-text-primary">{sender?.displayName ?? 'Unknown'}</span>
        <span className="shrink-0 text-xs text-text-muted">{formatSendTime(message.createdAt)}</span>
      </div>
      <p className="line-clamp-3 flex items-start gap-1 text-sm text-text-secondary">
        {isMedia && (
          <span className="mt-0.5">
            <KindGlyph kind={message.kind} />
          </span>
        )}
        <span>
          {leadingEllipsis && '… '}
          {segments.map((seg, i) =>
            seg.match ? (
              // Literal highlight color (not a design token) — same accepted
              // exception as the error-color literals (CLAUDE.md/PROJECT §11):
              // a search-match highlight has no sensible mapping onto
              // surface/text/accent tokens, which are already meaningful
              // elsewhere (accent = actionable, not "matched").
              <mark key={i} className="rounded-[2px] bg-yellow-200 px-0.5 text-neutral-900 dark:bg-yellow-500/40 dark:text-yellow-50">
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </span>
      </p>
    </button>
  );
}

function SearchFilterRow({
  members,
  filters,
  onChangeFilters,
}: {
  members: PublicUser[];
  filters: MessageSearchFilters;
  onChangeFilters: (next: MessageSearchFilters) => void;
}) {
  const chips: { key: keyof MessageSearchFilters; label: string }[] = [];
  if (filters.from) {
    const name = members.find((m) => m.id === filters.from)?.displayName ?? 'Unknown';
    chips.push({ key: 'from', label: `From: ${name}` });
  }
  if (filters.since) chips.push({ key: 'since', label: `Since ${filters.since}` });
  if (filters.until) chips.push({ key: 'until', label: `Until ${filters.until}` });

  return (
    <div className="flex flex-col gap-2 border-b border-border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filters.from}
          onChange={(e) => onChangeFilters({ ...filters, from: e.target.value })}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary"
          style={{ touchAction: 'manipulation' }}
          aria-label="Sender"
        >
          <option value="">Anyone</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={filters.since}
          onChange={(e) => onChangeFilters({ ...filters, since: e.target.value })}
          aria-label="Since"
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary"
          style={{ touchAction: 'manipulation' }}
        />
        <span className="text-xs text-text-muted">–</span>
        <input
          type="date"
          value={filters.until}
          onChange={(e) => onChangeFilters({ ...filters, until: e.target.value })}
          aria-label="Until"
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary"
          style={{ touchAction: 'manipulation' }}
        />
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => onChangeFilters({ ...filters, [chip.key]: '' })}
              className="flex items-center gap-1 rounded-pill bg-surface-sunken px-2 py-1 text-xs text-text-secondary"
              style={{ touchAction: 'manipulation' }}
            >
              {chip.label}
              <X size={11} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Shared body: text input + filter row + results list. `variant` only
 *  changes the outer chrome around this (see the two exported wrappers
 *  below). */
function SearchBody({
  variant,
  chatId,
  members,
  searchState,
  onChangeSearchState,
  onClose,
  onJumpToMessage,
}: {
  variant: 'mobile' | 'desktop';
  chatId: string;
  members: PublicUser[];
  searchState: SearchFormState;
  onChangeSearchState: (updater: (prev: SearchFormState) => SearchFormState) => void;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}) {
  const { qInput, filters } = searchState;
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } = useMessageSearch(chatId, filters);
  const results = flattenSearchResults(data?.pages);
  const totalCount = data?.pages[0]?.totalCount ?? null;
  const scrollerRef = useRef<HTMLDivElement>(null);

  function commitFilters(next: MessageSearchFilters) {
    onChangeSearchState((s) => ({ ...s, filters: next }));
  }

  function submitQuery(e: React.FormEvent) {
    e.preventDefault();
    commitFilters({ ...filters, q: qInput });
  }

  // Near-bottom auto-fetch (docs/MESSAGE_SEARCH.md §4.3), mirroring
  // ChatView's own scroll-triggered pagination (`onScrollerScroll`) rather
  // than a manual "Load more" button.
  function onScroll() {
    const el = scrollerRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) void fetchNextPage();
  }

  const searched = hasSearchCriteria(filters);

  return (
    <>
      <header
        className="flex items-center gap-2 border-b border-border px-3 py-3"
        style={variant === 'mobile' ? { paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' } : undefined}
      >
        {variant === 'mobile' ? (
          <button onClick={onClose} aria-label="Close search" className="flex shrink-0 items-center text-text-secondary" style={{ touchAction: 'manipulation' }}>
            <ArrowLeft size={20} />
          </button>
        ) : (
          <span className="text-sm font-semibold text-text-primary">Search</span>
        )}
        <form onSubmit={submitQuery} className="min-w-0 flex-1">
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoFocus={variant === 'mobile'}
            value={qInput}
            onChange={(e) => onChangeSearchState((s) => ({ ...s, qInput: e.target.value }))}
            placeholder="Search messages"
            className="w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted"
            style={{ touchAction: 'manipulation' }}
          />
        </form>
        {variant === 'desktop' && (
          <button onClick={onClose} aria-label="Close search" className="flex shrink-0 items-center text-text-secondary" style={{ touchAction: 'manipulation' }}>
            <X size={18} />
          </button>
        )}
      </header>

      <SearchFilterRow members={members} filters={filters} onChangeFilters={commitFilters} />

      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {!searched && <p className="p-6 text-center text-sm text-text-muted">Search this chat's messages, or filter by sender/date.</p>}

        {searched && (
          <>
            {totalCount !== null && (
              <p className="px-3 pt-2 text-xs text-text-muted">
                {totalCount} {totalCount === 1 ? 'result' : 'results'}
              </p>
            )}
            {isLoading && <p className="p-4 text-center text-sm text-text-muted">Searching…</p>}
            {!isLoading && results.length === 0 && <p className="p-6 text-center text-sm text-text-muted">No matches.</p>}
            {results.map((m) => (
              <SearchResultRow key={m.id} message={m} members={members} query={filters.q.trim()} onJump={onJumpToMessage} />
            ))}
            {isFetchingNextPage && <p className="p-3 text-center text-xs text-text-muted">Loading more…</p>}
          </>
        )}
      </div>
    </>
  );
}

/** Mobile: full-screen overlay above the chat, below MediaViewer's z-50
 *  layer (docs/MESSAGE_SEARCH.md §4.3) — same tier as the gallery's
 *  MobileTagSheet (both `z-40`). Registers on the back stack so device back
 *  closes search, not the chat (state is preserved either way — see
 *  ChatView's `searchState`, not local state here). */
export function MessageSearchOverlay(props: {
  chatId: string;
  members: PublicUser[];
  searchState: SearchFormState;
  onChangeSearchState: (updater: (prev: SearchFormState) => SearchFormState) => void;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}) {
  useBackHandler(true, props.onClose);
  return (
    <div
      className="fixed inset-0 z-40 flex flex-col bg-surface"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <SearchBody
        variant="mobile"
        chatId={props.chatId}
        members={props.members}
        searchState={props.searchState}
        onChangeSearchState={props.onChangeSearchState}
        onClose={props.onClose}
        onJumpToMessage={props.onJumpToMessage}
      />
    </div>
  );
}

/** Desktop: a proper ~360px right-side panel, flex sibling of the message
 *  column (§4.3) — no overlay, no backdrop; the chat list stays usable
 *  beside it. */
export function MessageSearchPanel(props: {
  chatId: string;
  members: PublicUser[];
  searchState: SearchFormState;
  onChangeSearchState: (updater: (prev: SearchFormState) => SearchFormState) => void;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}) {
  return (
    <div className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface-raised">
      <SearchBody
        variant="desktop"
        chatId={props.chatId}
        members={props.members}
        searchState={props.searchState}
        onChangeSearchState={props.onChangeSearchState}
        onClose={props.onClose}
        onJumpToMessage={props.onJumpToMessage}
      />
    </div>
  );
}
