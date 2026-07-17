/**
 * Drizzle schema — Den.
 *
 * DELIBERATELY EMPTY IN STAGE 0.
 *
 * The full data model (BACKBONE §5) ships as migration 001 in Stage 1:
 * users (nullable password_hash + email), auth_identities and
 * webauthn_credentials (auth-ready, MVP writes nothing to them), invite_codes,
 * sessions, push_subscriptions, friendships, chats, chat_members, messages,
 * media, tags, media_tags.
 *
 * Do not add tables here until the Stage 1 task — keeping this empty is how we
 * honour "stages ship in order" (CLAUDE.md scope rules).
 */

export {};
