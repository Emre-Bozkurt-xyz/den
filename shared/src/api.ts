/**
 * Shared API DTOs (BACKBONE §6). Both /app and /server import these — never
 * redefine a payload shape on one side.
 *
 * Stage 0 defines only the auth/me and push surfaces plus the error envelope.
 * Later stages append friends, chats, messages, media, gallery, and tag DTOs
 * here as they are built — do not scatter them into /app or /server.
 */

/** Fastify error handler returns exactly this shape. Client maps `code`,
 *  never string-matches `message` (BACKBONE Conventions). */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

/** Stable error codes the client may branch on. Extend as needed. */
export const ErrorCode = {
  Unauthorized: 'unauthorized',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Validation: 'validation',
  RateLimited: 'rate_limited',
  InvalidInvite: 'invalid_invite',
  UsernameTaken: 'username_taken',
  InvalidCredentials: 'invalid_credentials',
  Internal: 'internal',
} as const;

export type ErrorCodeName = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── auth / identity (Stage 1; shapes reserved here for /me now) ────────────

export interface PublicUser {
  id: string; // BIGINT serialized as string — never lose precision to JS number
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** GET /me → current user, or 401 with ApiError. */
export type MeResponse = PublicUser;

/** POST /auth/register. Invites authorize; the provider (here, password)
 *  authenticates. OAuth/passkeys do NOT bypass invites (BACKBONE §5). */
export interface RegisterRequest {
  inviteCode: string;
  username: string;
  displayName: string;
  password: string;
}

/** POST /auth/login. */
export interface LoginRequest {
  username: string;
  password: string;
}

/** Register and login both return the authenticated user (session set via cookie). */
export type AuthResponse = PublicUser;

/** PATCH /me — account settings stub (Stage 1: display name only; avatar
 *  upload needs R2, Stage 3). */
export interface UpdateMeRequest {
  displayName?: string;
}

/** Client-side validation limits, shared so both sides agree (§ auth rules). */
export const AuthLimits = {
  usernameMin: 3,
  usernameMax: 32,
  /** Normalized charset for usernames: lowercase letters, digits, _ and -. */
  usernamePattern: '^[a-z0-9_-]+$',
  displayNameMax: 64,
  passwordMin: 8,
  passwordMax: 200,
} as const;

// ─── push (Stage 0 PoC + Stage 2 real) ──────────────────────────────────────

/** Browser PushSubscription, serialized for POST /push/subscribe. */
export interface PushSubscribeRequest {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Public VAPID key handed to the client so it can subscribe. */
export interface PushConfigResponse {
  vapidPublicKey: string;
}

// ─── friending (Stage 2, BACKBONE §5/§6) ────────────────────────────────────

export type FriendshipStatus = 'pending' | 'accepted';

/** One row of `GET /friends`: the other user plus the relationship to them.
 *  `direction` is who sent a still-pending request; null once accepted. */
export interface FriendEntry {
  user: PublicUser;
  status: FriendshipStatus;
  direction: 'incoming' | 'outgoing' | null;
  createdAt: string; // ISO 8601
}

/** GET /friends — split into the three lists the UI actually renders. */
export interface FriendsResponse {
  friends: FriendEntry[];
  incoming: FriendEntry[];
  outgoing: FriendEntry[];
}

/** POST /friends/requests. */
export interface SendFriendRequestBody {
  username: string;
}

// ─── chats & messages (Stage 2, BACKBONE §5/§6) ─────────────────────────────

export type MessageKind = 'text' | 'image' | 'video' | 'voice' | 'system';

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  kind: MessageKind;
  body: string | null;
  createdAt: string; // ISO 8601
  /** Present iff kind is 'image'|'video'|'voice' (Stage 3). */
  media: MediaInfo | null;
}

/** DMs are 2-member chats with isGroup=false — never special-cased (BACKBONE §5/§11). */
export interface ChatSummary {
  id: string;
  isGroup: boolean;
  name: string | null; // null for DMs; client derives a display name from `members`
  avatarUrl: string | null;
  members: PublicUser[];
  lastMessage: Message | null;
  unreadCount: number;
  createdAt: string;
}

export interface ChatsResponse {
  chats: ChatSummary[];
}

/** POST /chats. 1 memberId ⇒ DM (returns the existing DM if one already exists
 *  with that friend); 2+ ⇒ new group. All memberIds must already be accepted
 *  friends of the caller (friendship gates DMs and group adds — BACKBONE §2). */
export interface CreateChatRequest {
  memberIds: string[];
  name?: string;
}

/** GET /chats/:id/messages?before=&limit= — keyset pagination, newest page
 *  first (id DESC); nextCursor feeds the next `before` for older history. */
export interface MessagesResponse {
  messages: Message[];
  nextCursor: string | null;
}

/** POST /chats/:id/read. */
export interface MarkReadRequest {
  messageId: string;
}

/** POST /chats/:id/messages/delete and .../restore (Stage 6 / §2 item 11).
 *  All ids must belong to this chat and be sent by the caller — mixed
 *  batches are rejected whole, nothing written (docs/MESSAGE_DELETE.md §3). */
export interface MessageIdsRequest {
  messageIds: string[];
}

export const ChatLimits = {
  nameMax: 64,
  messageBodyMax: 4000,
  messagesPageDefault: 50,
  messagesPageMax: 100,
  maxGroupMembers: 50,
  deleteBatchMax: 100,
} as const;

// ─── media (Stage 3, BACKBONE §5/§6/§7) ─────────────────────────────────────

export type MediaKind = 'image' | 'video' | 'voice';
export type MediaStatus = 'processing' | 'ready' | 'failed';

/** Media metadata attached to a message. `Message.media` is null for
 *  kind='text'|'system'. Never carries R2 keys — only short-lived presigned
 *  URLs the server mints on read (hard invariant 2). */
export interface MediaInfo {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  mime: string;
  sizeBytes: string; // BIGINT serialized as string
  width: number | null;
  height: number | null;
  durationMs: number | null;
  url: string | null; // presigned GET; null until status='ready'
  thumbUrl: string | null; // presigned GET for thumb; null for voice or not-ready
}

/** POST /media/uploads. Server enforces per-kind max size (§6): images 25MB,
 *  video 500MB, voice 20MB — never trust the client beyond these ceilings. */
export interface CreateUploadRequest {
  chatId: string;
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
}

export interface CreateUploadResponse {
  mediaId: string;
  presignedPutUrl: string;
  /** Caller must PUT with this exact Content-Type header (SigV4-signed). */
  requiredContentType: string;
}

/** POST /media/:id/complete. Optional `body` = caption text on the message. */
export interface CompleteUploadRequest {
  body?: string;
}

/** GET /media/:id/url response — fresh presigned GET pair, re-mintable any
 *  time (they expire; the client re-requests rather than caching long-term). */
export interface MediaUrlResponse {
  url: string;
  thumbUrl: string | null;
}

export const MediaLimits = {
  maxBytes: {
    image: 25 * 1024 * 1024,
    video: 500 * 1024 * 1024,
    voice: 20 * 1024 * 1024,
  },
  /** Presigned URL lifetimes (§7 R2 hygiene: GETs ≤ 1h; PUT is short-lived too). */
  putUrlTtlSeconds: 10 * 60,
  getUrlTtlSeconds: 60 * 60,
} as const satisfies { maxBytes: Record<MediaKind, number>; putUrlTtlSeconds: number; getUrlTtlSeconds: number };

// ─── tags (Stage 5, BACKBONE §5/§6) ─────────────────────────────────────────

/** Per-chat tag registry entry. Shared-wiki permissions: any member may
 *  attach/detach any tag (CLAUDE.md hard invariant 5) — no per-tag owner. */
export interface Tag {
  id: string;
  name: string;
  usageCount: number;
}

/** GET /chats/:id/tags?prefix= — autocomplete, ranked by usage. */
export interface TagsAutocompleteResponse {
  tags: Tag[];
}

/** POST /media/:id/tags. Server normalizes `name` (BACKBONE §5) and creates
 *  the tag in the chat's registry if it doesn't already exist. */
export interface AddTagRequest {
  name: string;
}

/** GET /media/:id/tags — the tags currently attached to one media item.
 *  The gallery gets tags batched into `GalleryItem`; this exists for the
 *  chat-side viewer, which opens straight from a message bubble and has no
 *  gallery page to inherit them from (docs/UI_REVAMP.md UI-7). */
export interface MediaTagsResponse {
  tags: Tag[];
}

// ─── gallery (Stage 4, BACKBONE §5/§6/§9) ───────────────────────────────────

/** One tile in a per-chat gallery grid. `messageId` powers "jump to message". */
export interface GalleryItem {
  media: MediaInfo;
  messageId: string;
  chatId: string;
  createdAt: string; // ISO 8601, the message's createdAt (gallery sort key)
  tags: Tag[];
}

/** GET /chats/:id/gallery?kind=&q=&before=&limit= — keyset pagination on
 *  media id DESC, matching the messages-page pattern (BACKBONE §6). `q` is
 *  the raw booru query string (`beach -screenshots`); see shared/tags.ts
 *  `parseTagQuery`. An unresolvable positive tag returns an empty page,
 *  not an error (booru behavior — BACKBONE §5). */
export interface GalleryResponse {
  items: GalleryItem[];
  nextCursor: string | null;
}

/** One row of the top-level Gallery tab's chats-as-albums grid. */
export interface GalleryAlbum {
  chatId: string;
  name: string | null; // null for DMs; client derives via chatDisplayName like ChatSummary
  isGroup: boolean;
  members: PublicUser[];
  coverThumbUrl: string | null; // latest ready media's thumb (voice has none → null)
  mediaCount: number;
}

/** GET /gallery/albums — every chat the user is in that has ≥1 ready media
 *  item, newest activity first. Chats with zero media are omitted (an empty
 *  album tile has nothing useful to show). */
export interface GalleryAlbumsResponse {
  albums: GalleryAlbum[];
}

export const GalleryLimits = {
  pageDefault: 60,
  pageMax: 120,
} as const;
