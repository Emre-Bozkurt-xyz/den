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
