/**
 * Drizzle schema — Den.
 *
 * Migration 001 (Stage 1): the auth/identity layer from BACKBONE §5.
 *   users · auth_identities · webauthn_credentials · invite_codes · sessions ·
 *   push_subscriptions
 *
 * Migration 002 (Stage 2): chat core from BACKBONE §5.
 *   friendships · chats · chat_members · messages
 *
 * Migration 003 (Stage 3): media from BACKBONE §5/§7.
 *   media
 *
 * Migration 004 (Stage 5): tags from BACKBONE §5.
 *   tags · media_tags
 *
 * Migration 005 (post-MVP): replies + reactions.
 *   messages.reply_to_message_id (self-FK) · message_reactions
 *
 * Migration 006 (post-MVP, docs/MESSAGE_SEARCH.md): message search.
 *   pg_trgm extension + gin trigram index on messages.body (substring
 *   search, not tsvector FTS — see the plan doc for why).
 *
 * Migration 007 (post-MVP, docs/MESSAGE_EDIT.md): message edit.
 *   messages.edited_at (nullable timestamptz) — set on first edit; no index
 *   needed (idx_messages_body_trgm already covers search over edited bodies).
 *
 * Migration 008 (post-MVP, docs/VOICE_WAVEFORM.md): voice waveforms.
 *   media.waveform (nullable jsonb) — 44 RMS peaks (0–255) computed at
 *   processing time; voice only, null for image/video and legacy rows.
 *
 * Migration 009 (post-MVP, docs/RECEIPTS.md): delivered watermark.
 *   chat_members.last_delivered_message_id (nullable bigint, no FK, mirrors
 *   last_read_message_id) — advanced by a client delivery ack; both watermarks
 *   are guarded-monotonic writes (never move backwards).
 *
 * Migration 010 (post-MVP, docs/EMBEDS.md §4): embed framework + Instagram.
 *   embeds — belongs to a message exactly as media does; messages_kind_check
 *   gains 'embed'.
 *
 * Migration 011 (post-MVP, docs/EMBEDS.md §5): Vault account linking.
 *   vault_links — one row per Den user; OAuth tokens ENCRYPTED at rest
 *   (server/src/integrations/crypto.ts), never sent to the client.
 *
 * Migration 015 (post-MVP, docs/AUTH_HARDENING.md §2.2): login throttle.
 *   login_failures — append-only record of every failed login, keyed by the
 *   SUBMITTED username (which may not exist). Doubles as the per-account
 *   brute-force bound and the audit trail; there was previously neither.
 *
 * Migration 016 (post-MVP, docs/ADMIN_CONSOLE.md): the owner console's
 *   substrate. security_events (append-only history) · users.is_owner ·
 *   users.disabled_at · invite_codes.revoked_at.
 *
 * Migration 017 (post-MVP, docs/SIGNIN_FREEZE.md): sign-in freeze.
 *   users.logins_frozen_at · app_settings (first singleton config row).
 *
 * ⚠️ auth_identities and webauthn_credentials ship NOW but MVP writes NOTHING to
 * them (OAuth = post-MVP #2, passkeys = post-MVP #1). They exist so those land
 * as an INSERT pattern, not a migration. Do not implement OAuth/passkeys yet.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { UserSettings } from '@den/shared';

/** Case-insensitive text. Requires `CREATE EXTENSION citext` (in migration 001). */
const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/** COSE public key blob for passkeys (post-MVP; column exists from 001). */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

// ─── users & auth ───────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  username: citext('username').notNull().unique(),
  displayName: text('display_name').notNull(),
  email: citext('email').unique(), // nullable in MVP; OAuth account-linking key later
  passwordHash: text('password_hash'), // argon2id; NULLABLE — OAuth-only accounts have none
  avatarKey: text('avatar_key'), // R2 key, nullable
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Migration 013 (post-MVP, docs/MEDIA_ATTACHMENTS.md §4.2/§4.3, D11): the
  // first jsonb preference bag. May be `{}` or missing keys (pre-migration
  // rows, or keys added after a user's last PATCH) — always read through
  // mergeUserSettings (server/src/routes/auth.ts), never trust it raw.
  settings: jsonb('settings').$type<Partial<UserSettings>>().notNull().default({}),
  // Migration 016 (docs/ADMIN_CONSOLE.md §4). ⚠️ Grantable ONLY from the host
  // shell (`npm run owner grant`) — there is deliberately no API route and no
  // in-app toggle, not even for an existing owner, so a fully compromised
  // session still cannot escalate privilege.
  isOwner: boolean('is_owner').notNull().default(false),
  // Migration 016 (docs/ADMIN_CONSOLE.md §7). Set → sessions are destroyed and
  // every login path refuses. NOT a delete: messages, media and memberships
  // are untouched, because they are part of other people's conversations.
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  // Migration 017 (docs/SIGNIN_FREEZE.md). Set → no NEW session may be created
  // for this account by any means, even with correct credentials. ⚠️ Existing
  // sessions are untouched: that is the entire point, and `resolveSession`
  // must never consult this or freezing would sign everyone out.
  loginsFrozenAt: timestamp('logins_frozen_at', { withTimezone: true }),
});

/**
 * Server-wide settings — a single row, id always 1 (migration 017,
 * docs/SIGNIN_FREEZE.md §2).
 *
 * ⚠️ Kept SEPARATE from `users.logins_frozen_at` rather than folded into one
 * "is frozen" flag: lifting a global lockdown must not silently clear the
 * per-user freezes an owner set during the same incident. Two switches, either
 * of which freezes; neither knows about the other.
 *
 * First config table in Den. Keep it to genuinely global operational state —
 * anything per-user belongs on `users`, anything per-preference belongs in
 * `users.settings`.
 */
export const appSettings = pgTable('app_settings', {
  id: integer('id').primaryKey().default(1),
  /** Set → every account is frozen, regardless of its own flag. */
  signinsFrozenAt: timestamp('signins_frozen_at', { withTimezone: true }),
  updatedBy: bigint('updated_by', { mode: 'bigint' }).references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    provider: text('provider').notNull(), // 'google' | 'github' | ...
    providerUserId: text('provider_user_id').notNull(), // STABLE id (Google 'sub'). ⚠️ never key on email
    emailAtLink: citext('email_at_link'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('auth_identities_provider_uid').on(t.provider, t.providerUserId)],
);

export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: text('id').primaryKey(), // credential ID (base64url) from authenticator
  userId: bigint('user_id', { mode: 'bigint' })
    .notNull()
    .references(() => users.id),
  publicKey: bytea('public_key').notNull(), // COSE public key
  signCount: bigint('sign_count', { mode: 'bigint' }).notNull().default(sql`0`),
  transports: text('transports').array(), // ['internal','hybrid',...]
  deviceLabel: text('device_label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const inviteCodes = pgTable('invite_codes', {
  code: text('code').primaryKey(), // random, generated by admin CLI
  createdBy: bigint('created_by', { mode: 'bigint' }).references(() => users.id), // nullable: first invite has no creator
  usedBy: bigint('used_by', { mode: 'bigint' }).references(() => users.id),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Migration 016: soft revoke of an UNUSED code (invariant 8). A revoked code
  // can never be claimed; a code already used is history and is left alone.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // random 256-bit token, cookie value
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

/**
 * Failed-login ledger (docs/AUTH_HARDENING.md §2.2, migration 015).
 *
 * ⚠️ `username` is what the caller SUBMITTED, not a foreign key — rows are
 * written for usernames that don't exist too. That is deliberate: a throttle
 * that only engaged for real accounts would answer "does this user exist?"
 * from the outside, undoing the constant-time/no-enumeration work in
 * routes/auth.ts. No FK to `users` for the same reason.
 *
 * A successful login DELETES the account's rows, so this table holds only
 * unresolved failures — it is a live counter, not history. Anything wanting
 * durable history should read the logs.
 */
export const loginFailures = pgTable(
  'login_failures',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    username: citext('username').notNull(),
    /** Best-effort: currently a constant in prod (see §1 of the plan doc). */
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The hot query: failures for one username inside the window.
    index('login_failures_username_time').on(t.username, t.createdAt),
    // Sweeping expired rows.
    index('login_failures_time').on(t.createdAt),
  ],
);

/**
 * Append-only security history (docs/ADMIN_CONSOLE.md §5, migration 016).
 *
 * ⚠️ This is NOT a duplicate of `login_failures`, and the difference is
 * load-bearing. `login_failures` is a **live counter**: rows are deleted the
 * moment a user logs in successfully, because its only job is answering "is
 * this account locked right now?". This table is **durable history**: nothing
 * ever deletes from it, because its job is answering "what happened last
 * Tuesday?". Merging them would break one of the two — either the counter
 * stops clearing on success, or the history evaporates every time an attack
 * ends.
 *
 * `user_id` is nullable and `username` is stored verbatim, so an event about a
 * username that never existed is still recorded. `actor_user_id` is set only
 * for deliberate owner actions — a console that cannot say who did what
 * manufactures deniability.
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    kind: text('kind').notNull(),
    /** The account the event is ABOUT. Null when no such user exists. */
    userId: bigint('user_id', { mode: 'bigint' }).references(() => users.id),
    /** As submitted/known at the time — survives a user that never existed. */
    username: citext('username'),
    /** Who DID it, for owner actions. Null for system-generated events. */
    actorUserId: bigint('actor_user_id', { mode: 'bigint' }).references(() => users.id),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Kind-specific extras. Keep flat and JSON-primitive, like users.settings. */
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('security_events_time').on(t.createdAt),
    index('security_events_user_time').on(t.userId, t.createdAt),
    index('security_events_kind_time').on(t.kind, t.createdAt),
  ],
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('push_subscriptions_user').on(t.userId)],
);

// ─── friendships & chats (Stage 2) ──────────────────────────────────────────

export const friendships = pgTable(
  'friendships',
  {
    userA: bigint('user_a', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    userB: bigint('user_b', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(), // 'pending' | 'accepted'
    requestedBy: bigint('requested_by', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userA, t.userB] }),
    check('friendships_status_check', sql`${t.status} IN ('pending','accepted')`),
    check('friendships_order_check', sql`${t.userA} < ${t.userB}`),
  ],
);

export const chats = pgTable('chats', {
  id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
  isGroup: boolean('is_group').notNull(),
  name: text('name'), // null for DMs (derive from other member)
  avatarKey: text('avatar_key'),
  // "minId:maxId" for DMs, null for groups — enforces one DM chat per pair (§5).
  dmKey: text('dm_key').unique(),
  createdBy: bigint('created_by', { mode: 'bigint' })
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const chatMembers = pgTable(
  'chat_members',
  {
    chatId: bigint('chat_id', { mode: 'bigint' })
      .notNull()
      .references(() => chats.id),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'bigint' }), // unread counts
    // Migration 009 (post-MVP, docs/RECEIPTS.md): true device-delivery
    // watermark, distinct from lastReadMessageId — advanced by a client ack
    // when a message actually reaches this device (not just "server has it").
    lastDeliveredMessageId: bigint('last_delivered_message_id', { mode: 'bigint' }),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    check('chat_members_role_check', sql`${t.role} IN ('owner','member')`),
    index('chat_members_user').on(t.userId),
  ],
);

// ─── messages (Stage 2 text; media kinds land Stage 3) ──────────────────────

export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    chatId: bigint('chat_id', { mode: 'bigint' })
      .notNull()
      .references(() => chats.id),
    senderId: bigint('sender_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(), // 'text' | 'image' | 'video' | 'voice' | 'system'
    body: text('body'), // text content or caption
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Post-MVP (migration 005): self-referencing FK for message replies.
    // Nullable — most messages aren't replies. No ON DELETE behavior specified;
    // soft-deletes mean the referenced row is never actually removed (§5/CLAUDE.md #8).
    replyToMessageId: bigint('reply_to_message_id', { mode: 'bigint' }).references(
      (): AnyPgColumn => messages.id,
    ),
    // Post-MVP (migration 007, docs/MESSAGE_EDIT.md): set the first time the
    // message's body is edited; null if never edited. No time limit on edits.
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'messages_kind_check',
      // 'embed' added migration 010 (docs/EMBEDS.md §4.1).
      sql`${t.kind} IN ('text','image','video','voice','embed','system')`,
    ),
    index('idx_messages_chat').on(t.chatId, t.id.desc()),
    // Substring search over body (text + captions), not word/stemmer-based
    // FTS — pg_trgm handles mixed-language/partial-word matches the way
    // Discord-style search is expected to (docs/MESSAGE_SEARCH.md §3.1).
    // Requires `CREATE EXTENSION pg_trgm` (hand-added to the generated
    // migration, same convention as citext in migration 001 — see
    // CITEXT_EXTENSION below).
    index('idx_messages_body_trgm').using('gin', t.body.op('gin_trgm_ops')),
  ],
);

// ─── media (Stage 3) ─────────────────────────────────────────────────────

export const media = pgTable(
  'media',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id),
    uploaderId: bigint('uploader_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(), // 'image' | 'video' | 'voice'
    r2Key: text('r2_key').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    width: bigint('width', { mode: 'number' }), // images/videos
    height: bigint('height', { mode: 'number' }),
    durationMs: bigint('duration_ms', { mode: 'number' }), // videos/voice
    waveform: jsonb('waveform').$type<number[]>(), // voice only: 44 RMS peaks 0–255 (docs/VOICE_WAVEFORM.md)
    thumbKey: text('thumb_key'), // R2 key of thumbnail (null for voice)
    status: text('status').notNull().default('processing'), // 'processing' | 'ready' | 'failed'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('media_kind_check', sql`${t.kind} IN ('image','video','voice')`),
    check('media_status_check', sql`${t.status} IN ('processing','ready','failed')`),
    index('idx_media_message').on(t.messageId),
  ],
);

// ─── embeds (post-MVP, docs/EMBEDS.md §4.1) ──────────────────────────────

export const embeds = pgTable(
  'embeds',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id),
    provider: text('provider').notNull(), // 'instagram' | 'vault' | 'klipy'
    status: text('status').notNull().default('processing'), // 'processing' | 'ready' | 'failed'
    // Normalized card snapshot (provider-agnostic — the shared client
    // renderer, EmbedCard.tsx, reads only these, never provider internals).
    title: text('title'),
    subtitle: text('subtitle'), // author handle / doc owner
    description: text('description'), // caption / summary
    thumbKey: text('thumb_key'), // R2 key of the snapshot image (nullable)
    canonicalUrl: text('canonical_url'), // external URL (deep-link target)
    providerRef: text('provider_ref'), // IG shortcode | vault documentId
    contentKind: text('content_kind'), // 'video' | 'image' | 'document' | 'gif'
    // 'inline' (docs/GIFS.md §5, D7) = the card IS the content, nothing to open.
    actionType: text('action_type').notNull().default('external'), // 'external' | 'read' | 'portal' | 'inline'
    data: jsonb('data').$type<Record<string, unknown>>(), // provider extras (og:video url, etc.)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('embeds_provider_check', sql`${t.provider} IN ('instagram','vault','klipy')`),
    check('embeds_status_check', sql`${t.status} IN ('processing','ready','failed')`),
    check('embeds_action_type_check', sql`${t.actionType} IN ('external','read','portal','inline')`),
    index('idx_embeds_message').on(t.messageId),
  ],
);

// ─── tags (Stage 5) ──────────────────────────────────────────────────────

export const tags = pgTable(
  'tags',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    chatId: bigint('chat_id', { mode: 'bigint' })
      .notNull()
      .references(() => chats.id),
    name: citext('name').notNull(), // normalized (§5): lowercase, spaces→hyphens
    usageCount: integer('usage_count').notNull().default(0),
    createdBy: bigint('created_by', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tags_chat_id_name_unique').on(t.chatId, t.name)],
);

export const mediaTags = pgTable(
  'media_tags',
  {
    mediaId: bigint('media_id', { mode: 'bigint' })
      .notNull()
      .references(() => media.id),
    tagId: bigint('tag_id', { mode: 'bigint' })
      .notNull()
      .references(() => tags.id),
    taggedBy: bigint('tagged_by', { mode: 'bigint' }) // attribution only, not ownership (§5)
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.mediaId, t.tagId] }),
    index('idx_media_tags_tag').on(t.tagId, t.mediaId), // the gallery-query index (§5)
  ],
);

// ─── message reactions (post-MVP, migration 005) ────────────────────────

export const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index('idx_message_reactions_message').on(t.messageId), // aggregation query
  ],
);

// ─── Vault account linking (post-MVP, docs/EMBEDS.md §5.1) ───────────────

/** Den as an OUTBOUND OAuth 2.0 client of Vault (vault.ems-place.com) — one
 *  row per Den user. Tokens are ENCRYPTED at rest (server/src/integrations/
 *  crypto.ts, app-level key from env) and NEVER serialized into any API
 *  response (CLAUDE.md hard invariant 2's spirit: server-only secrets stay
 *  server-only). Distinct from `auth_identities`/roadmap #2 (Den's own login
 *  OAuth) — this is linking, not authentication. */
export const vaultLinks = pgTable('vault_links', {
  userId: bigint('user_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => users.id),
  vaultUserId: text('vault_user_id').notNull(), // Vault's user UUID (from GET /api/me)
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  scope: text('scope'),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Migration 012 (docs/EMBEDS.md §6.2, Phase 4) — the chat Stage.
 *
 * `chat_vault_groups` maps a Den chat to the Vault GROUP that owns its docs,
 * one per chat, created lazily on first Stage use. The group — not any person
 * and not Den — owns the documents, so they survive any member leaving
 * (bridge §C.7). Den mirrors chat membership into it (embeds/vaultGroups.ts).
 *
 * Migration 013 (docs/MEDIA_ATTACHMENTS.md §4.2/§4.3, D11): `users.settings`.
 *   First jsonb bag in an otherwise strict schema — one migration ever beats
 *   one per preference. Typed `UserSettings` lives in `/shared`; the server
 *   whitelists + merges on `PATCH /me` (server/src/routes/auth.ts) so the
 *   column can never accumulate unknown or mistyped keys. Column may hold a
 *   partial object (rows written before a key existed, or never PATCHed) —
 *   always read through the merge helper, never trust it directly.
 */
export const chatVaultGroups = pgTable('chat_vault_groups', {
  chatId: bigint('chat_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => chats.id),
  vaultGroupId: text('vault_group_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A Vault document pinned to a chat's Stage. Shared-wiki semantics, exactly
 * like tags (§10): any member adds or removes any doc, `added_by` is
 * attribution only. Soft-deleted (invariant 8) — and note that removing a doc
 * from the Stage never deletes the Vault document, which the group still owns.
 */
export const chatVaultDocs = pgTable(
  'chat_vault_docs',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    chatId: bigint('chat_id', { mode: 'bigint' })
      .notNull()
      .references(() => chats.id),
    vaultDocumentId: text('vault_document_id').notNull(),
    title: text('title'), // cached for the grid; refreshed from Vault metadata
    addedBy: bigint('added_by', { mode: 'bigint' }).references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('chat_vault_docs_unique').on(t.chatId, t.vaultDocumentId),
    index('idx_chat_vault_docs_chat').on(t.chatId),
  ],
);

// ─── GIF favorites (post-MVP, migration 015, docs/GIF_FAVORITES.md) ─────────

/**
 * Migration 015 (docs/GIF_FAVORITES.md §4): per-user GIF favorites.
 *
 * ⚠️ **This table HARD-DELETES on unfavorite** (D-F2), which is a deliberate
 * carve-out from CLAUDE.md invariant 8, not an oversight. "Soft deletes only"
 * governs *content* — messages, media, Stage docs — where disappearance is a
 * loss and history matters. A favorite is a per-user toggle edge, and every
 * comparable table in this schema already hard-deletes: `message_reactions`,
 * `media_tags`, `friendships`, `vault_links`. A `deleted_at` here would also
 * make re-favoriting an *un-delete* rather than an insert, which is strictly
 * worse. See `server/src/gifs/favorites.ts`.
 *
 * Nothing here is chat-scoped: a favorite references a public provider id, not
 * a Den object, so it crosses no chat boundary and needs no membership gate.
 */
export const gifFavorites = pgTable(
  'gif_favorites',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id),
    // Mirrors embeds_provider_check deliberately. docs/GIFS.md §2 says to
    // assume a provider swap will happen (this feature exists because Tenor's
    // API was discontinued); a favorites table hardcoded to Klipy is exactly
    // what would make that swap expensive.
    provider: text('provider').notNull(),
    /** CANONICAL slug — never a suffixed search-result one (docs/GIFS.md §12).
     *  The unique index below sits on this rather than on `providerItemId`
     *  because it is the handle both the send path and DELETE take; that is
     *  also what makes a double-add a harmless no-op. */
    providerRef: text('provider_ref').notNull(),
    /** The provider's stable per-item id (docs/GIF_FAVORITES.md §2), which is
     *  how a *search result* is matched against this row — its slug can't be.
     *
     *  `text`, not `bigint`: Klipy's ids are ~16 digits and would fit, but
     *  they're opaque handles, not numbers. Nothing sorts, sums or ranges over
     *  them, a future provider's ids may not be numeric at all, and text
     *  sidesteps the bigint↔JSON dance for a value only ever compared for
     *  equality.
     *
     *  **Nullable** — §2's floor again. If the provider ever stops reporting
     *  an id, favoriting must still work; only the picker's pre-filled star is
     *  lost. A NOT NULL here would have turned a cosmetic degradation into a
     *  failed write. */
    providerItemId: text('provider_item_id'),
    /** Klipy CDN URL, derived server-side at favorite time — never accepted
     *  from the client (D-F3), because this column is later loaded in an
     *  <img>. Perishable third-party state (D-F4): when it rots the tile goes
     *  dead, but the favorite stays sendable since the send path re-resolves
     *  from `providerRef`. */
    previewUrl: text('preview_url').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    title: text('title').notNull(), // alt text — an accessibility field
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('gif_favorites_provider_check', sql`${t.provider} IN ('klipy')`),
    uniqueIndex('gif_favorites_user_item').on(t.userId, t.provider, t.providerRef),
    // The list query: one user's favorites, newest first, keyset-paginated on
    // id (PROJECT.md §6 — no OFFSET in new code).
    index('idx_gif_favorites_user').on(t.userId, t.id.desc()),
  ],
);

/** Raw SQL run before the tables in migration 001 (citext type must exist). */
export const CITEXT_EXTENSION = sql`CREATE EXTENSION IF NOT EXISTS citext`;

/** Raw SQL hand-added to migration 006 (pg_trgm's gin index needs the
 *  extension present first) — see idx_messages_body_trgm above. Standard
 *  Postgres contrib module; present in the postgres:16-alpine compose image
 *  and any normal VPS Postgres install. */
export const PG_TRGM_EXTENSION = sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
