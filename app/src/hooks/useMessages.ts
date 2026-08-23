import { useInfiniteQuery } from '@tanstack/react-query';
import type { Message, MessagesResponse } from '@den/shared';
import { fetchMessages } from '../lib/chats';

/** Keyset-paginated message history (BACKBONE §6). Each page is newest-first
 *  (id DESC, matching the server's index); `flattenMessages` below produces
 *  the ascending order the chat view renders. */
export function useMessages(chatId: string | null) {
  return useInfiniteQuery({
    queryKey: ['messages', chatId] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) => fetchMessages(chatId!, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: MessagesResponse) => lastPage.nextCursor,
    enabled: chatId !== null,
    // Waking the phone must not refetch this query. TanStack's focus refetch
    // of an *infinite* query re-runs every loaded page sequentially, so a
    // reader who had scrolled back through history paid N round-trips on a
    // just-woken radio before one new message could render — the chat looked
    // frozen until they backed out and came in again (owner report,
    // 2026-08-23). Resume is owned explicitly instead: `RealtimeProvider`
    // fetches the newest page once and merges it (`lib/messageSync.ts`), which
    // is bounded no matter how much history is loaded. Mount and WS frames are
    // untouched — `refetchOnMount` still reconciles a chat you re-open.
    // ...and the same for the network's own reconnect edge, which TanStack
    // handles identically. `RealtimeProvider` listens to `online` too, so this
    // is covered — by one request instead of N.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Oldest → newest, flattened across pages, for rendering top-to-bottom. */
export function flattenMessages(pages: MessagesResponse[] | undefined): Message[] {
  if (!pages) return [];
  return pages
    .slice()
    .reverse()
    .flatMap((p) => [...p.messages].reverse());
}
