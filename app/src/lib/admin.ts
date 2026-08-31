/**
 * Owner console client (docs/ADMIN_CONSOLE.md §3).
 *
 * ⚠️ The destructive calls (revoke invite, revoke sessions, disable/enable)
 * throw `reauth_required` until the caller has proved who they are in the last
 * few minutes (§6). Callers must handle that code by prompting rather than
 * showing it as an error — `isReauthRequired` below is the check.
 *
 * Every call here 403s for a non-owner regardless of what the client believes
 * about `me.isOwner` — that flag only decides whether the entry point renders.
 */
import { startAuthentication } from '@simplewebauthn/browser';
import type {
  AdminInvitesResponse,
  AdminLocksResponse,
  AdminPushHealthResponse,
  AdminSessionsResponse,
  AdminUsersResponse,
  MintInvitesResponse,
  PasskeyCeremonyOptions,
  ReauthStatus,
  SecurityEventsResponse,
  SigninFreezeResponse,
} from '@den/shared';
import { ApiFetchError, api } from './api';

export function adminEvents(opts: { before?: string; kind?: string; userId?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.before) q.set('before', opts.before);
  if (opts.kind) q.set('kind', opts.kind);
  if (opts.userId) q.set('userId', opts.userId);
  const qs = q.toString();
  return api<SecurityEventsResponse>(`/api/admin/events${qs ? `?${qs}` : ''}`);
}

export function adminUsers(): Promise<AdminUsersResponse> {
  return api<AdminUsersResponse>('/api/admin/users');
}

export function adminUserSessions(userId: string): Promise<AdminSessionsResponse> {
  return api<AdminSessionsResponse>(`/api/admin/users/${encodeURIComponent(userId)}/sessions`);
}

export function adminInvites(): Promise<AdminInvitesResponse> {
  return api<AdminInvitesResponse>('/api/admin/invites');
}

export function adminLocks(): Promise<AdminLocksResponse> {
  return api<AdminLocksResponse>('/api/admin/locks');
}

export function adminPushHealth(): Promise<AdminPushHealthResponse> {
  return api<AdminPushHealthResponse>('/api/admin/push-health');
}

// ─── re-authentication (docs/ADMIN_CONSOLE.md §6) ───────────────────────────

/** True when a call failed only because proof of identity has gone stale. */
export function isReauthRequired(err: unknown): boolean {
  return err instanceof ApiFetchError && err.code === 'reauth_required';
}

export function reauthStatus(): Promise<ReauthStatus> {
  return api<ReauthStatus>('/api/admin/reauth');
}

export function reauthWithPassword(password: string): Promise<{ freshSeconds: number }> {
  return api('/api/admin/reauth/password', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

/**
 * ⚠️ Must be called straight from a click handler — the WebAuthn ceremony
 * needs the user-gesture chain intact (docs/PASSKEYS.md §10).
 */
export async function reauthWithPasskey(): Promise<{ freshSeconds: number }> {
  const options = await api<PasskeyCeremonyOptions>('/api/admin/reauth/passkey/options', {
    method: 'POST',
  });
  const response = await startAuthentication({
    optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
  });
  return api('/api/admin/reauth/passkey/verify', {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

// ─── actions ────────────────────────────────────────────────────────────────

export function clearLock(username: string): Promise<{ cleared: number }> {
  return api(`/api/admin/locks/${encodeURIComponent(username)}/clear`, { method: 'POST' });
}

export function mintInvites(count = 1): Promise<MintInvitesResponse> {
  return api<MintInvitesResponse>('/api/admin/invites', {
    method: 'POST',
    body: JSON.stringify({ count }),
  });
}

/** Needs fresh auth. */
export function revokeInvite(code: string): Promise<void> {
  return api(`/api/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
}

/** Needs fresh auth. Never touches the caller's own current session. */
export function revokeSessions(userId: string): Promise<{ revoked: number }> {
  return api(`/api/admin/users/${encodeURIComponent(userId)}/sessions`, { method: 'DELETE' });
}

/** Needs fresh auth. */
export function disableUser(userId: string): Promise<void> {
  return api(`/api/admin/users/${encodeURIComponent(userId)}/disable`, { method: 'POST' });
}

/** Needs fresh auth. */
export function enableUser(userId: string): Promise<void> {
  return api(`/api/admin/users/${encodeURIComponent(userId)}/enable`, { method: 'POST' });
}

// ─── sign-in freeze (docs/SIGNIN_FREEZE.md) ─────────────────────────────────
//
// No re-auth on these: freezing is reversible and low-harm, and a prompt on
// every flip would train the owner to click through it.

export function signinFreeze(): Promise<SigninFreezeResponse> {
  return api<SigninFreezeResponse>('/api/admin/signin-freeze');
}

/** The server-wide switch — freezes every account at once. */
export function setGlobalSigninFreeze(frozen: boolean): Promise<void> {
  return api(`/api/admin/signin-freeze/${frozen ? 'on' : 'off'}`, { method: 'POST' });
}

/** One account's own switch, independent of the global one. */
export function setUserSigninFreeze(userId: string, frozen: boolean): Promise<void> {
  return api(
    `/api/admin/users/${encodeURIComponent(userId)}/signin-freeze/${frozen ? 'on' : 'off'}`,
    { method: 'POST' },
  );
}
