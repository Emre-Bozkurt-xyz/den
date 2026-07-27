/**
 * Environment/config loader. Reads process.env once, validates the essentials,
 * and exposes a typed frozen config object. Fail fast on missing required vars.
 */

import { loadDotenv } from './env-file.js';

// Populate process.env from the root .env for local runs before we read it.
// No-op under Docker/prod (compose injects env). This must run before the
// required()/optional() calls below execute during module evaluation.
loadDotenv();

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined ? fallback : v;
}

const NODE_ENV = optional('NODE_ENV', 'development');
const isProd = NODE_ENV === 'production';

export const env = Object.freeze({
  nodeEnv: NODE_ENV,
  isProd,
  publicOrigin: optional('PUBLIC_ORIGIN', 'http://localhost:5173'),
  host: optional('API_HOST', '0.0.0.0'),
  port: Number(optional('API_PORT', '3000')),

  // Postgres is required even in Stage 0 (health check does SELECT 1).
  databaseUrl: required('DATABASE_URL'),

  // Session cookie signing. Required in prod; dev gets a throwaway default.
  sessionSecret: isProd
    ? required('SESSION_SECRET')
    : optional('SESSION_SECRET', 'dev-insecure-session-secret-change-me'),
  cookieDomain: optional('COOKIE_DOMAIN') || undefined,

  // Web Push (VAPID). Optional at boot so the server still starts before keys
  // are generated; the push routes check presence and 503 if unset.
  vapidPublicKey: optional('VAPID_PUBLIC_KEY') || undefined,
  vapidPrivateKey: optional('VAPID_PRIVATE_KEY') || undefined,
  vapidSubject: optional('VAPID_SUBJECT', 'mailto:admin@ems-place.com'),

  // R2 (media, Stage 3 — BACKBONE §3/§7). Locally this points at the
  // docker-compose MinIO service (S3-compatible); prod points it at the real
  // R2 account endpoint. `r2PublicEndpoint` lets a server-side endpoint
  // (e.g. Docker's internal `minio:9000`) differ from the browser-reachable
  // one (`localhost:9000`) — presigned URLs are re-hosted onto it before
  // being handed to the client. In prod both are the same public R2 host, so
  // no rewrite happens.
  r2Endpoint: optional('R2_ENDPOINT', 'http://localhost:9000'),
  r2PublicEndpoint: optional('R2_PUBLIC_ENDPOINT') || undefined,
  r2Region: optional('R2_REGION', 'auto'),
  r2Bucket: optional('R2_BUCKET', 'den-media'),
  r2AccessKeyId: optional('R2_ACCESS_KEY_ID', 'den-dev'),
  r2SecretAccessKey: optional('R2_SECRET_ACCESS_KEY', 'den-dev-secret'),
  r2ForcePathStyle: optional('R2_FORCE_PATH_STYLE', 'true') === 'true',

  // Vault account linking (docs/EMBEDS.md §5) — Den as an OUTBOUND OAuth 2.0
  // client of Vault. Distinct from Den's own future login-OAuth (roadmap #2,
  // `/auth/oauth/*`) — these never touch that reserved surface.
  vaultIssuer: optional('VAULT_ISSUER', 'https://vault.ems-place.com'),
  vaultClientId: optional('VAULT_CLIENT_ID', 'den'),
  vaultClientSecret: optional('VAULT_CLIENT_SECRET') || undefined,
  // Computed from `publicOrigin` when unset (prod: app + API are same-origin
  // behind Caddy, so this is just `${publicOrigin}/api/integrations/vault/callback`).
  vaultRedirectUri: optional('VAULT_REDIRECT_URI') || undefined,
  // Encrypts vault_links' stored tokens (server/src/integrations/crypto.ts).
  // Hashed into a 32-byte AES-256-GCM key regardless of input length.
  //
  // Deliberately NOT `required()` in prod, even though it is a real secret:
  // it used to be, and a missing value took the ENTIRE app down in a crash
  // loop (required() throws during module evaluation) over an optional
  // integration. Now an unset key disables Vault linking and nothing else —
  // see `vaultLinkingEnabled` below. There is intentionally NO prod fallback
  // default: silently encrypting real OAuth tokens under a publicly-known
  // key would be worse than the feature being off.
  vaultTokenEncKey: isProd
    ? optional('VAULT_TOKEN_ENC_KEY') || undefined
    : optional('VAULT_TOKEN_ENC_KEY', 'dev-insecure-vault-token-key-change-me'),
  // Vault SERVICE token (docs/EMBEDS.md §7.1 item 2) — the second, higher tier
  // of trust: the OAuth client above acts *as a user*, but only this token can
  // create groups, own documents and manage membership. Issued once in
  // plaintext by Vault's `scripts/seed-service.mjs --slug den --name "Den"`.
  // Deliberately NOT required in prod: leaving it unset degrades the Stage to
  // read-only rather than refusing to boot the whole server.
  vaultServiceToken: optional('VAULT_SERVICE_TOKEN') || undefined,
});

export type Env = typeof env;

/**
 * Can users link a Vault account at all? False when `VAULT_TOKEN_ENC_KEY` is
 * unset in prod — without it there is nowhere safe to store OAuth tokens, so
 * every `/integrations/vault/*` route refuses (503) and the Stage reports the
 * viewer as unlinked. The rest of Den is unaffected: an optional integration
 * must never be able to stop the app from booting.
 */
export const vaultLinkingEnabled = Boolean(env.vaultTokenEncKey);
