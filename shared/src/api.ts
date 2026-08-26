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
  /** Too many failed logins for this account — the credential check is
   *  refused outright until the lock expires (docs/AUTH_HARDENING.md §2.2).
   *  Distinct from `rate_limited`, which is a per-client flood backstop: this
   *  one is keyed to the *account* and is not cleared by changing network. */
  AuthLocked: 'auth_locked',
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
/** docs/GIFS.md §9 — the ceiling applied to this user's GIF search/trending
 *  requests. Klipy's own `rating` values, plus `'off'` for "send no rating
 *  param at all", i.e. no filtering. */
export const GIF_RATINGS = ['g', 'pg', 'pg-13', 'r', 'off'] as const;
export type GifRating = (typeof GIF_RATINGS)[number];

export interface UserSettings {
  /** docs/MEDIA_ATTACHMENTS.md §5.5 — when true the gallery never blurs
   *  sensitive media. Chat still does: the gallery is a place you navigated
   *  to on purpose, chat is a surface you scroll past in public. */
  galleryShowSensitive: boolean;
  /** docs/GIFS.md §9 / D9 — per-user, because a fixed PG gate is the wrong
   *  default for a closed adult friend circle while an unfiltered default is
   *  the wrong first impression. Governs what this user can FIND; it
   *  deliberately does not filter what they RECEIVE (Den has no moderation by
   *  design — PROJECT.md §1). GIFs carry no tags and never reach the gallery,
   *  so this is the feature's only content control. */
  gifRating: GifRating;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  galleryShowSensitive: false,
  gifRating: 'pg-13',
};

/** GET /me → current user (+ their settings), or 401 with ApiError. */
export interface MeResponse extends PublicUser {
  settings: UserSettings;
  /** docs/GIFS.md §7 — whether the server has a Klipy key configured. A
   *  server capability rather than a user preference, but it rides here
   *  because the composer needs it on first paint and `/me` is already
   *  fetched at boot; a separate config request would just be a second
   *  round-trip for one boolean. False ⇒ the client hides the GIF button
   *  entirely (nothing the user could do would fix a missing server key). */
  gifsEnabled: boolean;
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

/**
 * Per-account login throttle (docs/AUTH_HARDENING.md §2.2). Shared so the
 * client can render an honest "try again in N minutes" instead of guessing.
 *
 * Keyed on the submitted username rather than the client address: Den sits
 * behind Cloudflare → VPS → frp → Caddy, and the real client IP does not
 * currently survive that chain, so an IP-keyed limit protects nothing.
 */
export const LoginThrottle = {
  /** Failures inside this window count toward the lock. */
  windowMs: 15 * 60 * 1000,
  /** Failures within the window before the account locks. */
  threshold: 10,
  /** First lock duration; doubles per additional failure. */
  baseLockMs: 60 * 1000,
  /** Ceiling on the doubling — a lock is annoying, never indefinite. */
  maxLockMs: 15 * 60 * 1000,
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
  /** docs/MEDIA_ATTACHMENTS.md §4.6 — intrinsic pixel size, read off the file
   *  on the sender's device before upload. A **cosmetic layout hint**, not
   *  data: it gives the `'processing'` row a real aspect ratio so every other
   *  member's placeholder is the right shape from the moment the album
   *  appears, instead of a fixed generic box that pops (and shoves the message
   *  list) when processing finishes seconds later.
   *
   *  Bounded, not trusted: the server clamps the ratio, normalizes away the
   *  pixel values, and **overwrites both with dimensions measured by
   *  sharp/ffprobe** — including the EXIF-orientation swap — the moment
   *  processing succeeds. Omitting them costs only today's generic
   *  placeholder. Never used for a size, storage, or billing decision;
   *  `completeUpload` still HEAD-verifies and sniffs the real bytes
   *  (CLAUDE.md invariant 7). */
  width?: number;
  height?: number;
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
  /** The provider's own id for this item (IG shortcode | Vault documentId |
   *  canonical Klipy slug). Exposed for docs/GIF_FAVORITES.md D-F6: a GIF
   *  already in a chat needs a handle to favorite with, and the alternative
   *  was parsing the slug back out of `canonicalUrl` — which for `klipy` is
   *  literally this value with a `https://klipy.com/gifs/` prefix, so nothing
   *  new is disclosed here, only something already derivable made explicit. */
  providerRef: string | null;
  contentKind: string | null;
  actionType: EmbedActionType;
  /** Intrinsic pixel size of `thumbUrl`, when the resolver knew it (projected
   *  out of `embeds.data` by the mapper — the client never sees the raw bag).
   *  Null for providers that don't report it, which is why `EmbedCard` still
   *  needs a fallback aspect. GIFs (docs/GIFS.md §8) always set these: they
   *  are arbitrary-aspect, and a card that can't reserve its box before the
   *  bytes decode regresses the chat's scroll-to-bottom (PROJECT.md §14,
   *  2026-07-22 — the same bug class `PreviewImage` exists to fix). */
  width: number | null;
  height: number | null;
}

// ─── GIFs (post-MVP, docs/GIFS.md §6) ───────────────────────────────────────

/** One picker result. A deliberately NORMALIZED shape, never Klipy's raw
 *  response — the provider lives behind `server/src/gifs/klipy.ts` so swapping
 *  it (a live risk: this feature exists because Tenor's API was discontinued
 *  mid-2026) never reaches the client. `slug` is the only field the client
 *  ever *sends back*; everything needed to render a sent GIF is re-fetched
 *  server-side (CLAUDE.md invariant 7). */
export interface GifSearchItem {
  slug: string;
  /** The provider's stable per-item id (docs/GIF_FAVORITES.md §2).
   *
   *  Read-only on the client and **never sent to the server** — it exists
   *  solely so the picker can tell whether a result is already favorited.
   *  It has to exist because `slug` cannot answer that: search-result slugs
   *  carry a rotating per-response suffix (docs/GIFS.md §12), so the same GIF
   *  arrives under a different slug every search, while favorites are stored
   *  under the canonical one. Measured stable across canonicalization
   *  2026-08-14 — see §2 for the caveat and the unfilled-star floor.
   *
   *  **Null is a supported state, not an error.** The GIF still renders,
   *  sends, and can be favorited (favoriting posts the slug — the id is read
   *  server-side from the resolver's own response). Only the pre-filled star
   *  is lost, which is the whole point of the floor: degrade a cosmetic hint,
   *  never drop a result. */
  itemId: string | null;
  /** Klipy CDN URL, used ONLY inside the open picker (docs/GIFS.md §9, D10).
   *  Never stored, never rendered in chat — sent GIFs always come from R2. */
  previewUrl: string;
  width: number;
  height: number;
  /** Alt text. An accessibility field, not decoration. */
  title: string;
}

// ─── GIF favorites (post-MVP, docs/GIF_FAVORITES.md) ────────────────────────

/** One stored favorite. Structurally a superset of `GifSearchItem` on purpose:
 *  the Favorites tab renders through the very same tile component as search
 *  results, and picking one sends through the very same `gif` intent. */
export interface GifFavorite {
  /** CANONICAL slug — never a suffixed search-result one. This is the handle
   *  the send path and `DELETE /gifs/favorites/:slug` both take. */
  slug: string;
  /** Null when the provider didn't report one (§2's floor) — the favorite is
   *  fully functional, it just won't pre-fill a star in the picker. */
  itemId: string | null;
  /** Klipy CDN URL, server-derived at favorite time (never client-supplied —
   *  docs/GIF_FAVORITES.md D-F3). Third-party and therefore perishable: when
   *  it rots the tile shows a dead placeholder, but the favorite stays
   *  *sendable*, because sending re-resolves from `slug` server-side (D-F4). */
  previewUrl: string;
  width: number;
  height: number;
  title: string;
}

/** GET /gifs/favorites — keyset paginated on `id` like every Den-owned list. */
export interface GifFavoritesResponse {
  items: GifFavorite[];
  nextCursor: string | null;
}

/** Just enough to answer "is this starred?" on all three surfaces at once
 *  (docs/GIF_FAVORITES.md §6). Carries both handles because they hold
 *  different ones: the picker matches on `itemId`, a chat card matches on
 *  `slug`, and the picker resolves `itemId → slug` from here when it needs to
 *  unfavorite — which is what lets DELETE keep a single key. */
export interface GifFavoriteKey {
  slug: string;
  itemId: string | null;
}

export interface GifFavoriteKeysResponse {
  keys: GifFavoriteKey[];
}

/** POST /gifs/favorites. A slug and nothing else — suffixed or canonical, the
 *  server resolves it either way and derives every stored field itself. */
export interface AddGifFavoriteRequest {
  slug: string;
}

/** GET /gifs/search and GET /gifs/trending. Keyed pagination isn't available
 *  upstream (Klipy is page-numbered), so this is the one paginated surface in
 *  Den that isn't keyset — it's a transient third-party result set, not a
 *  Den-owned table, so PROJECT.md §6's no-OFFSET rule doesn't bite. */
export interface GifSearchResponse {
  items: GifSearchItem[];
  hasNext: boolean;
}

export const GifLimits = {
  /** Klipy's own bounds: per_page min 8, max 50. */
  perPage: 24,
  /** Below this the picker shows trending instead of searching — keeps the
   *  test key's 100/hr from evaporating on single characters. */
  minQueryLength: 2,
  maxQueryLength: 100,
  /** Client-side debounce before a search fires (docs/GIFS.md §10). */
  searchDebounceMs: 350,
  /** Favorites per user (docs/GIF_FAVORITES.md §4). Not a storage limit — the
   *  rows are tiny — but `GET /gifs/favorites/keys` returns the whole set
   *  unpaginated, so the set has to stay bounded. Hitting it is an explicit
   *  error, never a silent drop. */
  maxFavorites: 500,
  /** Page size for the Favorites tab. */
  favoritesPerPage: 30,
  /** How long a press-and-hold on a picker tile must last before the favorite
   *  popover opens. Matches `ChatView`'s `LONG_PRESS_MS` deliberately: the two
   *  gestures are the same gesture on different surfaces, and a user who has
   *  learned the timing in chat should not have to relearn it here. */
  longPressMs: 500,
} as const;

// ─── Vault account linking (post-MVP, docs/EMBEDS.md §5) ────────────────────

/** GET /integrations/vault/status. Never carries tokens — those are
 *  server-only, encrypted at rest (CLAUDE.md hard invariant 2's spirit). */
export interface VaultStatusResponse {
  linked: boolean;
  vaultDisplayName: string | null;
}
