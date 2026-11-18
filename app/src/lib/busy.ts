/**
 * "The app is holding something a reload would destroy" — the signal
 * `lib/pwa.ts` consults before applying a service-worker update
 * (controllerchange → reload). Deliberately not React state: the SW code runs
 * outside the tree, and nothing here should ever cause a render.
 *
 * Two kinds, because they bound differently:
 *  - `upload` — a PUT/complete round is in flight (`lib/media.ts`). Always
 *    ends on its own: the PUT has a stall watchdog and every REST call has
 *    api.ts's timeout, so this hold can't outlive the network.
 *  - `composer` — a non-empty draft, staged attachments or a recording in the
 *    mounted composer. Unbounded (a draft can sit for days), which is why the
 *    reload gate lets the page going hidden override it but not `upload`.
 *
 * Holds are tokens, not a bare counter: `release` is idempotent, so a double
 * cleanup (StrictMode, an effect re-run racing a finally) can never release
 * someone else's hold and drive the count negative or let it stick.
 */
import { useEffect } from 'react';

export type BusyKind = 'upload' | 'composer';

const holds = new Map<symbol, BusyKind>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      // A broken listener must not stop the others or throw out of a
      // `release()` that's sitting in someone's `finally`.
      console.error('busy listener failed', err);
    }
  }
}

/** Takes a hold; call the returned function to release it (safe to call
 *  more than once). Pair it with try/finally or an effect cleanup. */
export function holdBusy(kind: BusyKind): () => void {
  const token = Symbol(kind);
  holds.set(token, kind);
  notify();
  return () => {
    if (!holds.delete(token)) return;
    notify();
  };
}

/** Any hold at all, or only holds of `kind`. */
export function isBusy(kind?: BusyKind): boolean {
  if (kind === undefined) return holds.size > 0;
  for (const k of holds.values()) if (k === kind) return true;
  return false;
}

/** Called after every hold/release. Returns an unsubscribe. */
export function onBusyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Holds `kind` for as long as `active` is true and the component is
 *  mounted — the effect cleanup is what guarantees an unmount can't leave
 *  the hold stuck. */
export function useBusyWhile(kind: BusyKind, active: boolean): void {
  useEffect(() => (active ? holdBusy(kind) : undefined), [kind, active]);
}
