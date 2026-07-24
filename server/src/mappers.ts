/** Row → DTO mappers. Keep the BIGINT→string boundary here so ids never leak as
 *  JS numbers (precision) into the API (see @den/shared PublicUser). */
import type {
  ChatSummary,
  EmbedActionType,
  EmbedInfo,
  EmbedProvider,
  EmbedStatus,
  MediaInfo,
  MediaKind,
  MediaStatus,
  Message as MessageDto,
  MessageKind,
  PublicUser,
  ReactionSummary,
  ReplyPreview,
} from '@den/shared';

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
  replyToMessageId: bigint | null;
  /** docs/MESSAGE_EDIT.md — null if never edited. */
  editedAt: Date | null;
}

export interface MediaRow {
  id: bigint;
  kind: string;
  status: string;
  mime: string;
  sizeBytes: bigint;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** docs/VOICE_WAVEFORM.md — voice only; null for image/video and legacy rows. */
  waveform: number[] | null;
}

/** `urls` is null until status='ready' — the worker hasn't minted a
 *  processed asset yet, so there's nothing to presign a GET for. */
export function toMediaInfo(m: MediaRow, urls: { url: string; thumbUrl: string | null } | null): MediaInfo {
  return {
    id: m.id.toString(),
    kind: m.kind as MediaKind,
    status: m.status as MediaStatus,
    mime: m.mime,
    sizeBytes: m.sizeBytes.toString(),
    width: m.width,
    height: m.height,
    durationMs: m.durationMs,
    waveform: m.waveform,
    url: urls?.url ?? null,
    thumbUrl: urls?.thumbUrl ?? null,
  };
}

export function toMessage(
  m: MessageRow,
  media: MediaInfo | null = null,
  replyTo: ReplyPreview | null = null,
  reactions: ReactionSummary[] = [],
  embed: EmbedInfo | null = null,
): MessageDto {
  return {
    id: m.id.toString(),
    chatId: m.chatId.toString(),
    senderId: m.senderId.toString(),
    kind: m.kind as MessageKind,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    media,
    embed,
    replyTo,
    reactions,
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
  };
}

// ─── embeds (post-MVP, docs/EMBEDS.md §4.2) ─────────────────────────────────

export interface EmbedRow {
  id: bigint;
  provider: string;
  status: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  canonicalUrl: string | null;
  providerRef: string | null;
  contentKind: string | null;
  actionType: string;
}

/** `thumbUrl` is passed in separately (like `toMediaInfo`'s `urls`) — it's a
 *  presigned GET minted at read time, never stored on the row itself. */
export function toEmbedInfo(e: EmbedRow, thumbUrl: string | null): EmbedInfo {
  return {
    id: e.id.toString(),
    provider: e.provider as EmbedProvider,
    status: e.status as EmbedStatus,
    title: e.title,
    subtitle: e.subtitle,
    description: e.description,
    thumbUrl,
    canonicalUrl: e.canonicalUrl,
    contentKind: e.contentKind,
    actionType: e.actionType as EmbedActionType,
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
  lastMessage: MessageDto | null;
  unreadCount: number;
}): ChatSummary {
  return {
    id: args.chat.id.toString(),
    isGroup: args.chat.isGroup,
    name: args.chat.name,
    avatarUrl: null, // group avatars need R2 (Stage 3)
    members: args.members.map(toPublicUser),
    lastMessage: args.lastMessage,
    unreadCount: args.unreadCount,
    createdAt: args.chat.createdAt.toISOString(),
  };
}
