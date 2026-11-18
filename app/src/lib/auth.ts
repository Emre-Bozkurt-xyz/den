import type {
  AuthResponse,
  LoginRequest,
  LogoutRequest,
  MeResponse,
  RegisterRequest,
  UpdateMeRequest,
} from '@den/shared';
import { api, ApiFetchError } from './api';
import { currentPushEndpoint } from './push';

/** GET /me → current user, or null when not authenticated (401). */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>('/api/me');
  } catch (e) {
    if (e instanceof ApiFetchError && e.status === 401) return null;
    throw e;
  }
}

export function register(body: RegisterRequest): Promise<AuthResponse> {
  return api<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
}

export function login(body: LoginRequest): Promise<AuthResponse> {
  return api<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Log out, detaching this device's push subscription from the account on the
 * way (the server deletes the row it names, scoped to the departing user).
 * Without the endpoint the server would keep pushing this user's chat
 * notifications to a device they just signed out of. The browser-side
 * subscription is kept on purpose — see `currentPushEndpoint`.
 */
export async function logout(): Promise<{ ok: true }> {
  const endpoint = await currentPushEndpoint();
  const body: LogoutRequest = endpoint ? { endpoint } : {};
  return api('/api/auth/logout', { method: 'POST', body: JSON.stringify(body) });
}

export function updateMe(body: UpdateMeRequest): Promise<MeResponse> {
  return api<MeResponse>('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
}
