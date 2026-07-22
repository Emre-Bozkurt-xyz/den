import type {
  ChatSummary,
  ChatsResponse,
  CreateChatRequest,
  Message,
  MessagesResponse,
  SearchMessagesResponse,
} from '@den/shared';
import { api } from './api';

/** DMs derive their display name from the other member; groups fall back to
 *  a comma-joined member list when unnamed (BACKBONE §5: "name null for DMs").
 *  Accepts any shape with these three fields — GalleryAlbum has them too, so
 *  gallery screens can reuse this without a full ChatSummary. */
export function chatDisplayName(chat: Pick<ChatSummary, 'name' | 'isGroup' | 'members'>, meId: string): string {
  const others = chat.members.filter((m) => m.id !== meId);
  if (!chat.isGroup) return others[0]?.displayName ?? 'Unknown';
  return chat.name ?? (others.map((m) => m.displayName).join(', ') || 'Group');
}

export function fetchChats(): Promise<ChatsResponse> {
  return api<ChatsResponse>('/api/chats');
}

export function createChat(body: CreateChatRequest): Promise<ChatSummary> {
  return api<ChatSummary>('/api/chats', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchMessages(chatId: string, before: string | null): Promise<MessagesResponse> {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  return api<MessagesResponse>(`/api/chats/${chatId}/messages${qs}`);
}

/** GET /chats/:id/messages/search (docs/MESSAGE_SEARCH.md §3/4.1). `filters`
 *  mirrors the search panel's committed form state — empty strings mean "no
 *  filter", omitted from the querystring entirely rather than sent blank. */
export function fetchMessageSearch(
  chatId: string,
  filters: { q: string; from: string; since: string; until: string },
  before: string | null,
): Promise<SearchMessagesResponse> {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.from) params.set('from', filters.from);
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  if (before) params.set('before', before);
  const qs = params.toString();
  return api<SearchMessagesResponse>(`/api/chats/${chatId}/messages/search${qs ? `?${qs}` : ''}`);
}

export function markRead(chatId: string, messageId: string): Promise<{ ok: true }> {
  return api(`/api/chats/${chatId}/read`, { method: 'POST', body: JSON.stringify({ messageId }) });
}

/** Soft-deletes the caller's own messages (Stage 6 / §2 item 11). The chat
 *  actually updates via the `message.deleted` WS broadcast (sender included
 *  in the room) — this call's return value is only the ids that actually
 *  transitioned, useful for deciding whether to show the undo toast at all. */
export function deleteMessages(chatId: string, messageIds: string[]): Promise<{ messageIds: string[] }> {
  return api(`/api/chats/${chatId}/messages/delete`, { method: 'POST', body: JSON.stringify({ messageIds }) });
}

/** Undoes a soft delete. See `deleteMessages` — propagation is via the
 *  `message.restored` WS broadcast, not this call's return value. */
export function restoreMessages(chatId: string, messageIds: string[]): Promise<{ messages: Message[] }> {
  return api(`/api/chats/${chatId}/messages/restore`, { method: 'POST', body: JSON.stringify({ messageIds }) });
}

/** Adds the caller's reaction (post-MVP). Idempotent add — the server
 *  broadcasts `reaction.added` to the chat room, including this socket; see
 *  `lib/realtime.tsx`'s pending-reaction dedup for why the caller doesn't
 *  double-apply its own echo. */
export function addReaction(chatId: string, messageId: string, emoji: string): Promise<{ ok: true }> {
  return api(`/api/chats/${chatId}/messages/${messageId}/reactions`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

/** Removes the caller's reaction (post-MVP) — a DELETE to the emoji itself
 *  (URL-encoded), not a toggle body; see `ReactRequest`'s doc comment in
 *  @den/shared for why add/remove are two distinct verbs. */
export function removeReaction(chatId: string, messageId: string, emoji: string): Promise<{ ok: true }> {
  return api(`/api/chats/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
    method: 'DELETE',
  });
}
