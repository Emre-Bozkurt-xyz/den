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

/** Thrown when a request outlived `REQUEST_TIMEOUT_MS`. A distinct code so
 *  callers can tell "the network ate it" from a real server answer; TanStack
 *  Query sees a rejection either way and retries it like any other. */
export class ApiTimeoutError extends Error {
  readonly code = 'timeout';
  constructor(readonly path: string) {
    super('request timed out');
    this.name = 'ApiTimeoutError';
  }
}

/** Every REST call is same-origin JSON against our own Fastify server; none of
 *  them legitimately take this long. The ceiling exists because a `fetch()`
 *  issued over a TCP connection the phone's radio silently dropped while the
 *  screen was off does not fail — it *hangs*, for as long as the OS takes to
 *  give up (tens of seconds, sometimes minutes). That would be merely slow if
 *  it were one request, but TanStack Query dedupes by query key: while the
 *  zombie is in flight, every later invalidate/refetch of the same key joins
 *  it instead of issuing a fresh one, so one hung request on resume freezes
 *  that query until the OS times out (owner report, 2026-08-23 — "the chat
 *  just doesn't load"). Aborting turns that into a rejection, which retries. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Same-origin JSON fetch. Cookies ride along (credentials: 'include'). */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  // A caller-supplied signal still wins — chain it into ours rather than
  // letting `...init` overwrite the abort we depend on below.
  init?.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  // The timer covers reading the body too, not just the headers — a stalled
  // connection can deliver a 200 and then never finish the stream.
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers:
        init?.body && !(init.body instanceof FormData)
          ? { 'Content-Type': 'application/json', ...init?.headers }
          : init?.headers,
      ...init,
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (timedOut) throw new ApiTimeoutError(path);
    throw err;
  } finally {
    clearTimeout(timer);
  }

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
