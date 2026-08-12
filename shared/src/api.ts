/**
 * Shared API DTOs (BACKBONE §6). Both /app and /server import these — never
 * redefine a payload shape on one side.
 *
 * Stage 0 defines only the auth/me and push surfaces plus the error envelope.
 * Later stages append friends, chats, messages, media, gallery, and tag DTOs
 * here as they are built — do not scatter them into /app or /server.
 */

import type { EmbedActionType, EmbedProvider, EmbedStatus } from './embeds.js';
import type { Sensitivity } from './tags.js';

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
  /** A feature is switched off by server configuration, not by permissions —
   *  e.g. Vault linking with no `VAULT_TOKEN_ENC_KEY` set. Distinct from
   *  `forbidden` (the caller could never fix that by retrying) and from
   *  `internal` (nothing is broken). Clients should present it as
   *  "unavailable", not as an error the user caused. */
  ServiceUnavailable: 'service_unavailable',
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

/** Per-user preferences (docs/MEDIA_ATTACHMENTS.md §4.3, migration 013).
 *  Stored as a single `users.settings` jsonb rather than a column per
 *  preference — the owner intends to keep adding settings for existing
 *  features, and one migration beats one per toggle. The server whitelists
 *  and MERGES these keys on write; it never stores an unknown key and never
 *  replaces the whole object. Keep this interface flat and JSON-primitive. */
export interface UserSettings {
  /** docs/MEDIA_ATTACHMENTS.md §5.5 — when true the gallery never blurs
   *  sensitive media. Chat still does: the gallery is a place you navigated
   *  to on purpose, chat is a surface you scroll past in public. */
  galleryShowSensitive: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  galleryShowSensitive: false,
};

/** GET /me → current user (+ their settings), or 401 with ApiError. */
export interface MeResponse extends PublicUser {
  settings: UserSettings;
}

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

/** PATCH /me — account settings (avatar upload still needs R2, Stage 3).
 *  `settings` is a PARTIAL: the server merges the whitelisted keys it
 *  recognizes onto the stored object and drops the rest, so an older client
 *  sending a subset can never clobber a preference it doesn't know about. */
export interface UpdateMeRequest {
  displayName?: string;
  settings?: Partial<UserSettings>;
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

export type MessageKind = 'text' | 'image' | 'video' | 'voice' | 'embed' | 'system';

/** Lightweight preview of the message a reply points at (post-MVP). Carried
 *  inline on `Message.replyTo` so the client can render a reply strip without
 *  a second fetch — the referenced message may be off-page or even deleted. */
export interface ReplyPreview {
  id: string; // referenced message id
  senderId: string;
  kind: MessageKind;
  preview: string; // short text: body snippet (<=120 chars) or media label; '' if none
  deleted: boolean; // referenced message is soft-deleted
}

/** One emoji's aggregate on a message (post-MVP reactions). */
export interface ReactionSummary {
  emoji: string;
  count: number;
  mine: boolean; // does the requesting user have this emoji on this message
}

export interface Message {
  id: string;
  chatId: string;
  senderId: string;
  kind: MessageKind;
  body: string | null;
  createdAt: string; // ISO 8601
  /** Media carried by this message (Stage 3; an ARRAY as of
   *  docs/MEDIA_ATTACHMENTS.md §4.1).
   *
   *  - `[]` for text/embed/system messages.
   *  - One entry for voice, and for every message sent before albums existed.
   *  - **Two or more = an album**: one send, one message, N media. `kind`
   *    stays the FIRST item's kind (no 'album' MessageKind, so
   *    `messages_kind_check` and every kind-branching code path are
   *    untouched) — album-ness is derived from `media.length > 1` everywhere.
   *
   *  Order is the order the user staged them in (media id ASC). */
  media: MediaInfo[];
  /** docs/EMBEDS.md §4.2 — present iff kind is 'embed'. Mirrors `media`:
   *  null until the placeholder is minted, populated (still `processing`)
   *  immediately after, then replaced wholesale by the `embed.ready` frame. */
  embed: EmbedInfo | null;
  /** Post-MVP: null when this message isn't a reply. */
  replyTo: ReplyPreview | null;
  /** Post-MVP: aggregated per-emoji counts; [] when the message has none. */
  reactions: ReactionSummary[];
  /** docs/MESSAGE_EDIT.md — ISO 8601, set the first time the message's body
   *  is edited; null if never edited. Own messages with a body only (text +
   *  media captions) — see EditMessageRequest. */
  editedAt: string | null;
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
 *  batches are rejected whole, nothing written (docs/archive/MESSAGE_DELETE.md §3). */
export interface MessageIdsRequest {
  messageIds: string[];
}

/** POST /chats/:id/messages/:messageId/edit (docs/MESSAGE_EDIT.md). Own
 *  messages only, body only (text messages and media captions — the edit
 *  never touches `media`). No time limit. */
export interface EditMessageRequest {
  body: string;
}

export interface EditMessageResponse {
  message: Message;
}

/** GET /chats/:id/receipts (docs/RECEIPTS.md) — every member's watermarks,
 *  viewer included (the client ignores its own row). Nulls mean "never read/
 *  delivered anything in this chat". `lastDeliveredMessageId` is true device
 *  delivery (not just "server has it") — see PROJECT.md §14 for the owner
 *  call. Ids are BIGINT-as-string; compare with BigInt(), not `<`/`>`. */
export interface ChatReceipt {
  userId: string;
  lastReadMessageId: string | null;
  lastDeliveredMessageId: string | null;
}

export interface ReceiptsResponse {
  receipts: ChatReceipt[];
}

export const ChatLimits = {
  nameMax: 64,
  messageBodyMax: 4000,
  messagesPageDefault: 50,
  messagesPageMax: 100,
  maxGroupMembers: 50,
  deleteBatchMax: 100,
  searchPageDefault: 25,
  searchPageMax: 50,
  searchQueryMax: 256,
} as const;

// ─── message search (post-MVP, docs/MESSAGE_SEARCH.md) ──────────────────────

/** GET /chats/:id/messages/search?... — keyset-paginated, id DESC. Every
 *  field is optional but at least one of `q`/`from`/`since`/`until` must be
 *  present (server 400s otherwise) — a bare "list everything" search isn't
 *  supported. `q` is a plain, case-insensitive substring match over
 *  `messages.body` (text messages *and* media captions); no token parsing,
 *  no fuzzy/stemmed ranking (docs/MESSAGE_SEARCH.md §1 icebox list). */
export interface SearchMessagesQuery {
  q?: string;
  from?: string; // sender userId
  since?: string; // ISO date (inclusive, start of day, UTC)
  until?: string; // ISO date (inclusive, end of day, UTC)
  before?: string; // keyset cursor (message id)
  limit?: string;
}

export interface SearchMessagesResponse {
  messages: Message[]; // reuses the Message DTO — replies/reactions/media come along free
  nextCursor: string | null;
  totalCount: number | null; // populated on the first page only (no `before`); null on later pages
}

// ─── reactions (post-MVP, BACKBONE §5/§6) ───────────────────────────────────

/** POST /chats/:id/messages/:messageId/reactions. Toggling off is a DELETE
 *  to .../reactions/:emoji (emoji URL-encoded), not this body — add/remove
 *  are two distinct idempotent verbs, not a toggle payload. */
export interface ReactRequest {
  emoji: string;
}

export const ReactionLimits = {
  emojiMaxLength: 32,
  quickEmojis: ['❤️', '😂', '👍', '😮', '😢', '🙏'],
} as const;

// ─── media (Stage 3, BACKBONE §5/§6/§7) ─────────────────────────────────────

export type MediaKind = 'image' | 'video' | 'voice';
export type MediaStatus = 'processing' | 'ready' | 'failed';

/** Bar count of a voice message's stored waveform (docs/VOICE_WAVEFORM.md).
 *  One constant for the server (computes/stores this many peaks) and the
 *  client (renders exactly this many bars, including the loading state, so
 *  the loading→real handoff never changes the bar layout). */
export const VOICE_WAVEFORM_BARS = 44;

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
  /** Voice only: VOICE_WAVEFORM_BARS RMS peaks quantized to 0–255, computed
   *  server-side at processing time (docs/VOICE_WAVEFORM.md). Null for
   *  image/video and for voice rows processed before the column existed. */
  waveform: number[] | null;
  url: string | null; // presigned GET; null until status='ready'
  thumbUrl: string | null; // presigned GET for thumb; null for voice or not-ready
  /** docs/MEDIA_ATTACHMENTS.md §4.3 — DERIVED server-side from this item's
   *  tags, never stored: `spoiler`/`nsfw` are ordinary per-chat tags
   *  (SENSITIVE_TAGS in shared/src/tags.ts) and the tag rows stay the single
   *  source of truth. 'nsfw' wins when both are attached. Null = render
   *  normally. Clients blur on this field alone — they must never
   *  string-match tag names themselves. */
  sensitivity: Sensitivity | null;
}

/** One staged attachment in a `POST /media/uploads` batch. */
export interface CreateUploadItem {
  kind: MediaKind;
  mime: string;
  sizeBytes: number;
}

/** POST /media/uploads (docs/MEDIA_ATTACHMENTS.md §4.4) — mints ONE message
 *  row plus one media row per item, and returns a presigned PUT per item.
 *  Server enforces per-kind max size (§6: images 25MB, video 500MB, voice
 *  20MB) per item and `items.length <= MediaLimits.maxAttachments` — never
 *  trust the client beyond these ceilings.
 *
 *  `caption`/`replyToId` moved here from /complete when albums landed: they
 *  belong to the *message*, which now covers N items, so they can no longer
 *  ride "the first item's" completion. */
export interface CreateUploadRequest {
  chatId: string;
  items: CreateUploadItem[];
  caption?: string;
  replyToId?: string;
}

export interface CreateUploadItemResponse {
  mediaId: string;
  presignedPutUrl: string;
  /** Caller must PUT with this exact Content-Type header (SigV4-signed). */
  requiredContentType: string;
}

export interface CreateUploadResponse {
  /** The single message row every item in `items` hangs off. */
  messageId: string;
  /** Same order as the request's `items`. */
  items: CreateUploadItemResponse[];
}

/** POST /media/:id/complete — per item, still.
 *
 *  `tags` are attached INSIDE this call, before any fanout
 *  (docs/MEDIA_ATTACHMENTS.md §4.4/D7): tagging over separate REST calls
 *  after the message went out would show every other client an unblurred
 *  `nsfw` image for a few hundred ms, which is the one thing the feature
 *  exists to prevent. Normalized + validated server-side like any other tag.
 *
 *  The invariant this preserves: *an item's tags are attached before that
 *  item ever appears in a `ready` state anywhere.* */
export interface CompleteUploadRequest {
  tags?: string[];
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
  /** docs/MEDIA_ATTACHMENTS.md §5.1 — max items the composer may stage into
   *  one album, enforced client-side at attach time (so the user is told
   *  immediately) AND server-side at mint time (never trust the client). */
  maxAttachments: 10,
} as const satisfies {
  maxBytes: Record<MediaKind, number>;
  putUrlTtlSeconds: number;
  getUrlTtlSeconds: number;
  maxAttachments: number;
};

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
 *  gallery page to inherit them from (docs/archive/UI_REVAMP.md UI-7). */
export interface MediaTagsResponse {
  tags: Tag[];
}

// ─── gallery (Stage 4, BACKBONE §5/§6/§9) ───────────────────────────────────

/** One tile in a per-chat gallery grid. `messageId` powers "jump to message".
 *  `senderId`/`createdAt` mirror the owning message (BACKBONE §15
 *  2026-07-22) — the client uses `senderId` to pick mine/theirs bubble
 *  colors for the voice segment's chat-skinned list, and `createdAt` for
 *  the caption's short date/time and future date grouping. */
export interface GalleryItem {
  media: MediaInfo;
  messageId: string;
  chatId: string;
  senderId: string;
  createdAt: string; // ISO 8601, the message's createdAt (gallery sort key)
  tags: Tag[];
}

/** `GET /chats/:id/gallery`'s `kind` filter. The bare `MediaKind`s still
 *  filter to exactly one kind (the Voice segment uses `voice`); `'visual'`
 *  is image OR video — the Media segment's grid (BACKBONE §15 2026-07-22,
 *  supersedes the old All/Images/Videos/Voice tabs). */
export type GalleryKindFilter = MediaKind | 'visual';

/** Every value the route accepts for `kind` — shared so server validation
 *  and any client-side checks stay in lockstep. */
export const GALLERY_KIND_FILTERS: readonly GalleryKindFilter[] = ['image', 'video', 'voice', 'visual'];

/** GET /chats/:id/gallery?kind=&q=&before=&limit= — keyset pagination on
 *  media id DESC, matching the messages-page pattern (BACKBONE §6). `q` is
 *  the raw booru query string (`beach -screenshots`); see shared/tags.ts
 *  `parseTagQuery`. An unresolvable positive tag returns an empty page,
 *  not an error (booru behavior — BACKBONE §5). */
export interface GalleryResponse {
  items: GalleryItem[];
  nextCursor: string | null;
  /** docs/GALLERY_FILMSTRIP.md §4 — total matches for the CURRENT filter
   *  (kind + tag query), populated on the first page only (no `before`) and
   *  null on later pages, exactly like `SearchMessagesResponse.totalCount`.
   *
   *  Filter-aware is the whole point: the viewer's filmstrip sizes its ghost
   *  slots off this, so counting the whole chat would make the rail claim
   *  hundreds of items while `beach -screenshots` matched thirty. */
  totalCount: number | null;
}

/** One row of the top-level Gallery tab's chats-as-albums grid. */
export interface GalleryAlbum {
  chatId: string;
  name: string | null; // null for DMs; client derives via chatDisplayName like ChatSummary
  isGroup: boolean;
  members: PublicUser[];
  coverThumbUrl: string | null; // latest ready media *with a thumbnail* (image/video); null if none has one
  /** docs/MEDIA_ATTACHMENTS.md §5.5 — the album tile on the Gallery tab would
   *  otherwise happily show an `nsfw` photo full-size as chat decoration.
   *  The server prefers the newest NON-sensitive thumb-having item as the
   *  cover; this is non-null only when every candidate was sensitive, in
   *  which case the client blurs the cover. Blur here is non-interactive:
   *  tapping the tile opens the album (there's nothing to reveal — the grid
   *  inside does its own per-item reveal). */
  coverSensitivity: Sensitivity | null;
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

// ─── embeds (post-MVP, docs/EMBEDS.md §4.2) ─────────────────────────────────

/** Carried inline on `Message.embed` when kind === 'embed' — mirrors
 *  `MediaInfo`'s shape/reasoning exactly: a provider-agnostic normalized
 *  snapshot the ONE shared client renderer (`EmbedCard.tsx`) reads, never
 *  provider internals. `status`/`thumbUrl` follow the same processing→ready
 *  lifecycle as media (placeholder card → `embed.ready` replaces it). */
export interface EmbedInfo {
  id: string;
  provider: EmbedProvider;
  status: EmbedStatus;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  thumbUrl: string | null; // presigned R2 GET, minted at read time (like media); null until ready
  canonicalUrl: string | null;
  contentKind: string | null;
  actionType: EmbedActionType;
}

// ─── Vault account linking (post-MVP, docs/EMBEDS.md §5) ────────────────────

/** GET /integrations/vault/status. Never carries tokens — those are
 *  server-only, encrypted at rest (CLAUDE.md hard invariant 2's spirit). */
export interface VaultStatusResponse {
  linked: boolean;
  vaultDisplayName: string | null;
}
