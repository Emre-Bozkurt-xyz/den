import { useQuery } from '@tanstack/react-query';
import { fetchReceipts } from '../lib/chats';

/** docs/RECEIPTS.md §4.4/§5.1 — every member's read/delivered watermarks for
 *  a chat. Mounted by `ChatView`; kept in its own query (not folded into
 *  `useChats`/`useMessages`) so a receipt-only WS frame can patch it via
 *  `setQueryData` without touching either of those caches. */
export function useReceipts(chatId: string | null) {
  return useQuery({
    queryKey: ['receipts', chatId] as const,
    queryFn: () => fetchReceipts(chatId!),
    enabled: chatId !== null,
  });
}
