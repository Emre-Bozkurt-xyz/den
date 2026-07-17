/** Row → DTO mappers. Keep the BIGINT→string boundary here so ids never leak as
 *  JS numbers (precision) into the API (see @den/shared PublicUser). */
import type { ChatSummary, Message as MessageDto, MessageKind, PublicUser } from '@den/shared';

export interface UserRow {
  id: bigint;
  username: string;
  displayName: string;
  avatarKey: string | null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id.toString(),
    username: u.username,
    displayName: u.displayName,
    // Avatars need presigned R2 GETs (Stage 3). Until then, no URL even if a key exists.
    avatarUrl: null,
  };
}

export interface MessageRow {
  id: bigint;
  chatId: bigint;
  senderId: bigint;
  kind: string;
  body: string | null;
  createdAt: Date;
}

export function toMessage(m: MessageRow): MessageDto {
  return {
    id: m.id.toString(),
    chatId: m.chatId.toString(),
    senderId: m.senderId.toString(),
    kind: m.kind as MessageKind,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  };
}

export interface ChatRow {
  id: bigint;
  isGroup: boolean;
  name: string | null;
  avatarKey: string | null;
  createdAt: Date;
}

export function toChatSummary(args: {
  chat: ChatRow;
  members: UserRow[];
  lastMessage: MessageRow | null;
  unreadCount: number;
}): ChatSummary {
  return {
    id: args.chat.id.toString(),
    isGroup: args.chat.isGroup,
    name: args.chat.name,
    avatarUrl: null, // group avatars need R2 (Stage 3)
    members: args.members.map(toPublicUser),
    lastMessage: args.lastMessage ? toMessage(args.lastMessage) : null,
    unreadCount: args.unreadCount,
    createdAt: args.chat.createdAt.toISOString(),
  };
}
