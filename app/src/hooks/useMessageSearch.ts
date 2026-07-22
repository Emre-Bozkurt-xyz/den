import { useInfiniteQuery } from '@tanstack/react-query';
import type { Message, SearchMessagesResponse } from '@den/shared';
import { fetchMessageSearch } from '../lib/chats';

/** The search panel's committed filter set — what's actually driving the
 *  query (docs/MESSAGE_SEARCH.md §4.1). Empty string = "no filter" for
 *  every field, matching how `<select>`/`<input type="date">` naturally
 *  report "nothing chosen". */
export interface MessageSearchFilters {
  q: string;
  from: string; // sender userId, '' = no filter
  since: string; // 'YYYY-MM-DD', '' = no filter
  until: string;
}

export const EMPTY_SEARCH_FILTERS: MessageSearchFilters = { q: '', from: '', since: '', until: '' };

/** Full per-chat search UI state, cached across `ChatView` remounts the same
 *  way `initialDraft`/`onDraftChange` cache draft text (App.tsx's
 *  `draftCacheRef` pattern) — surviving the mobile-overlay close/reopen
 *  cycle is the whole point (§4.1 "the hard requirement"). `qInput` is the
 *  live text-box value; `filters` is what was last submitted (Enter, or a
 *  filter control change) and is what the query key/`enabled` check use —
 *  kept separate so typing never search-as-you-types. */
export interface SearchFormState {
  panelOpen: boolean;
  qInput: string;
  filters: MessageSearchFilters;
}

export const INITIAL_SEARCH_STATE: SearchFormState = {
  panelOpen: false,
  qInput: '',
  filters: EMPTY_SEARCH_FILTERS,
};

/** At least one non-empty criterion is required — mirrors the server's
 *  "empty search" 400 (docs/MESSAGE_SEARCH.md §3.3) and gates the query so
 *  an all-empty form never fires a request. */
export function hasSearchCriteria(f: MessageSearchFilters): boolean {
  return !!(f.q.trim() || f.from || f.since || f.until);
}

/** Keyset-paginated per-chat message search, newest-first per page — mirrors
 *  `useGallery`. A generous `staleTime` (5 min) means reopening the overlay
 *  after a jump-away shows exactly what was there before, with no silent
 *  refetch shifting results underneath the user (§4.1). */
export function useMessageSearch(chatId: string, filters: MessageSearchFilters) {
  return useInfiniteQuery({
    queryKey: ['messageSearch', chatId, filters.q.trim(), filters.from, filters.since, filters.until] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) => fetchMessageSearch(chatId, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: SearchMessagesResponse) => lastPage.nextCursor,
    enabled: hasSearchCriteria(filters),
    staleTime: 5 * 60 * 1000,
  });
}

export function flattenSearchResults(pages: SearchMessagesResponse[] | undefined): Message[] {
  if (!pages) return [];
  return pages.flatMap((p) => p.messages);
}
