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

// ─── embed API (docs/EMBEDS.md §7 Contract B/B2/C) ──────────────────────────

/** Vault returns an opaque 404 for "can't read", "doesn't exist", and several
 *  authorization failures alike (its documented "never confirm existence"
 *  posture, bridge §10). Callers distinguish *only* this from a transport or
 *  5xx error — never try to infer which of the seven clone checks failed. */
export class VaultNotFoundError extends Error {
  constructor(message = 'Vault resource not found or not accessible') {
    super(message);
    this.name = 'VaultNotFoundError';
  }
}

async function embedRequest<T>(
  path: string,
  init: RequestInit & { bearer: string; actingUserToken?: string },
): Promise<T> {
  const { bearer, actingUserToken, ...rest } = init;
  const headers: Record<string, string> = {
    ...(rest.headers as Record<string, string> | undefined),
    authorization: `Bearer ${bearer}`,
  };
  // Dual-credential ops (clone): `Authorization` stays the service token and
  // the acting user rides a separate header (bridge §4 contract revision).
  if (actingUserToken) headers['x-vault-acting-user-token'] = actingUserToken;
  if (rest.body && !headers['content-type']) headers['content-type'] = 'application/json';

  const res = await timedFetch(vaultUrl(path), { ...rest, headers });
  if (res.status === 404) throw new VaultNotFoundError();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Vault ${path} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

export interface VaultDocMetadata {
  id: string;
  title: string;
  /** For a group-owned doc this is the GROUP name, not a person — Vault's
   *  real `ownerId` is the service principal (`den-system`), which must never
   *  reach Den's UI (docs/EMBEDS.md §7.1 item 3). */
  ownerName: string | null;
  snippet: string | null;
  updatedAt: string;
  canEdit: boolean;
}

export async function fetchVaultDocMetadata(accessToken: string, documentId: string): Promise<VaultDocMetadata> {
  return embedRequest<VaultDocMetadata>(`/api/embed/documents/${encodeURIComponent(documentId)}/metadata`, {
    bearer: accessToken,
  });
}

export interface VaultRenderedDoc {
  html: string;
  assets: unknown[];
}

/** ⚠️ Private-asset `<img>`s in this HTML authorize by Vault session cookie,
 *  which Den's cross-origin viewers do not have — they will not load. Public
 *  assets, text and structure render fine (docs/EMBEDS.md §7.1 item 5). */
export async function fetchVaultDocRendered(accessToken: string, documentId: string): Promise<VaultRenderedDoc> {
  return embedRequest<VaultRenderedDoc>(`/api/embed/documents/${encodeURIComponent(documentId)}/rendered`, {
    bearer: accessToken,
  });
}

export interface VaultDocListItem {
  id: string;
  title: string;
  folderPath: string | null;
  ownerName: string | null;
  visibility: 'private' | 'public';
  updatedAt: string;
  snippet: string | null;
}

/** GET /api/embed/documents (§7 Contract B2) — the clone picker's source list,
 *  read with the ACTING USER's bearer, not the service token. Excludes
 *  group-owned docs by design, so "absent here" never means "not clonable". */
export async function listVaultDocuments(
  accessToken: string,
  opts: { query?: string; limit?: number } = {},
): Promise<VaultDocListItem[]> {
  const params = new URLSearchParams();
  if (opts.query) params.set('query', opts.query);
  params.set('limit', String(opts.limit ?? 50));
  const data = await embedRequest<{ documents: VaultDocListItem[] }>(
    `/api/embed/documents?${params.toString()}`,
    { bearer: accessToken },
  );
  return data.documents;
}

/** POST /api/embed/editor-session (§7 Contract C) → the single-use portal URL.
 *  Never cache or reuse the result: the boot token is single-use, so even an
 *  iframe refresh fails closed and needs a freshly minted session. */
export async function createVaultEditorSession(accessToken: string, documentId: string): Promise<string> {
  const data = await embedRequest<{ embedUrl: string }>('/api/embed/editor-session', {
    method: 'POST',
    bearer: accessToken,
    body: JSON.stringify({ documentId }),
  });
  return data.embedUrl;
}

// ─── owner ops (service bearer — env.vaultServiceToken) ─────────────────────

function serviceToken(): string {
  const token = env.vaultServiceToken;
  if (!token) throw new Error('VAULT_SERVICE_TOKEN is not configured — Vault owner ops are unavailable');
  return token;
}

export async function createVaultGroup(name: string): Promise<string> {
  const data = await embedRequest<{ groupId: string }>('/api/embed/groups', {
    method: 'POST',
    bearer: serviceToken(),
    body: JSON.stringify({ name }),
  });
  return data.groupId;
}

/** Idempotent per the contract — re-adding an existing member is a no-op. */
export async function addVaultGroupMember(groupId: string, vaultUserId: string): Promise<void> {
  await embedRequest<unknown>(`/api/embed/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    bearer: serviceToken(),
    body: JSON.stringify({ vaultUserId }),
  });
}

/** Idempotent per the contract — removing an absent member is a no-op. */
export async function removeVaultGroupMember(groupId: string, vaultUserId: string): Promise<void> {
  await embedRequest<unknown>(
    `/api/embed/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(vaultUserId)}`,
    { method: 'DELETE', bearer: serviceToken() },
  );
}

/** Create an empty group-owned doc. Service bearer only — creating an empty
 *  document reads nothing, so no acting-user credential is required. */
export async function createVaultGroupDocument(title: string, groupId: string): Promise<string> {
  const data = await embedRequest<{ documentId: string }>('/api/embed/documents', {
    method: 'POST',
    bearer: serviceToken(),
    body: JSON.stringify({ title, groupId }),
  });
  return data.documentId;
}

/** Clone a doc the acting user can read into the chat's group — DUAL
 *  CREDENTIAL. The service token authorizes writing into the group; the user's
 *  own OAuth token authorizes reading the source.
 *
 *  ⚠️ The acting user must ALREADY be a member of `groupId` (clone check 6),
 *  otherwise this returns an opaque 404 indistinguishable from a missing
 *  group — callers must run the membership mirror first (vaultGroups.ts's
 *  `ensureChatGroupMembership`). */
export async function cloneVaultDocumentIntoGroup(args: {
  actingUserToken: string;
  sourceDocumentId: string;
  groupId: string;
  title?: string;
}): Promise<string> {
  const body: Record<string, string> = {
    sourceDocumentId: args.sourceDocumentId,
    groupId: args.groupId,
  };
  if (args.title) body.title = args.title;
  const data = await embedRequest<{ documentId: string }>('/api/embed/documents', {
    method: 'POST',
    bearer: serviceToken(),
    actingUserToken: args.actingUserToken,
    body: JSON.stringify(body),
  });
  return data.documentId;
}
