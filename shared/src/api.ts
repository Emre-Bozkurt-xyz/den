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
