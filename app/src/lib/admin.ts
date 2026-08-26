/**
 * Owner console client (docs/ADMIN_CONSOLE.md §3).
 *
 * ⚠️ Read-only by design in this pass. The state-changing endpoints (unlock,
 * revoke, disable) land as a separate change behind the §6 re-auth gate, so
 * the risky half is its own reviewable diff.
 *
 * Every call here 403s for a non-owner regardless of what the client believes
 * about `me.isOwner` — that flag only decides whether the entry point renders.
 */
import type {
  AdminInvitesResponse,
  AdminLocksResponse,
  AdminPushHealthResponse,
  AdminSessionsResponse,
  AdminUsersResponse,
  SecurityEventsResponse,
} from '@den/shared';
import { api } from './api';

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
