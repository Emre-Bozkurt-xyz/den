import type { ChatSummary, ChatsResponse, CreateChatRequest, Message, MessagesResponse } from '@den/shared';
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
