/**
 * HTTP client for Vault's OAuth 2.0 authorization server + userinfo endpoint
 * (docs/EMBEDS.md §7 Contract A). Den is the OUTBOUND client here — every
 * call in this file is server → Vault, the acting user's browser never talks
 * to Vault directly except the one authorize-redirect hop.
 *
 * ⚠️ Unverified against a live Vault in this environment — `VAULT_ISSUER`
 * (`vault.ems-place.com` by default) isn't reachable from here. The flow
 * typechecks and follows the OAuth2/PKCE spec exactly; see the executor
 * report for what a live-Vault pass needs to confirm (token shape, userinfo
 * field names, actual redirect_uri registration).
 */
import { env } from '../env.js';

const REQUEST_TIMEOUT_MS = 8_000;

export interface VaultTokenResponse {
  access_token: string;
  refresh_token?: string;
  /** Seconds until expiry, per RFC 6749 §5.1 — converted to an absolute
   *  `expiresAt` by the caller (integrations/vaultLinks.ts). */
  expires_in: number;
  scope?: string;
  token_type: string;
}

export interface VaultUserinfo {
  userId: string;
  name: string;
  image: string | null;
}

function vaultUrl(path: string): URL {
  return new URL(path, env.vaultIssuer);
}

async function timedFetch(input: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function tokenRequest(params: Record<string, string>): Promise<VaultTokenResponse> {
  const body = new URLSearchParams(params);
  const res = await timedFetch(vaultUrl('/oauth/token'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vault token endpoint returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as VaultTokenResponse;
}

/** Builds the `/oauth/authorize` redirect target — the one leg of this flow
 *  the user's browser follows directly (server/src/routes/integrations-vault.ts's
 *  `/connect`). */
export function buildAuthorizeUrl(args: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = vaultUrl('/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.vaultClientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('scope', 'vault.documents');
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<VaultTokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: env.vaultClientId,
    code_verifier: codeVerifier,
  };
  if (env.vaultClientSecret) params.client_secret = env.vaultClientSecret;
  return tokenRequest(params);
}

/** Rotating refresh (docs/EMBEDS.md §5.1: "30-day"). The response's
 *  `refresh_token` supersedes the one on file — callers must persist it, not
 *  reuse the old one on the next refresh. */
export async function refreshVaultToken(refreshToken: string): Promise<VaultTokenResponse> {
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.vaultClientId,
  };
  if (env.vaultClientSecret) params.client_secret = env.vaultClientSecret;
  return tokenRequest(params);
}

/** GET /api/me (§7 Contract A) with the acting user's bearer token. */
export async function fetchVaultUserinfo(accessToken: string): Promise<VaultUserinfo> {
  const res = await timedFetch(vaultUrl('/api/me'), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Vault userinfo endpoint returned ${res.status}`);
  const data = (await res.json()) as { userId: string; name: string; image?: string | null };
  return { userId: data.userId, name: data.name, image: data.image ?? null };
}
