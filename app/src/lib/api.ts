import type { ApiError } from '@den/shared';

/** Thrown on non-2xx; carries the server's stable error `code`. */
export class ApiFetchError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiFetchError';
    this.status = status;
    this.code = code;
  }
}

/** Same-origin JSON fetch. Cookies ride along (credentials: 'include'). */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json', ...init?.headers }
        : init?.headers,
    ...init,
  });

  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = data as ApiError | null;
    throw new ApiFetchError(
      res.status,
      err?.error?.code ?? 'internal',
      err?.error?.message ?? res.statusText,
    );
  }
  return data as T;
}
