import type {
  AuthResponse,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  UpdateMeRequest,
} from '@den/shared';
import { api, ApiFetchError } from './api';

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

export function logout(): Promise<{ ok: true }> {
  return api('/api/auth/logout', { method: 'POST' });
}

export function updateMe(body: UpdateMeRequest): Promise<MeResponse> {
  return api<MeResponse>('/api/me', { method: 'PATCH', body: JSON.stringify(body) });
}
