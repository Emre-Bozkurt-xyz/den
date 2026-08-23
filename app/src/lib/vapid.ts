/**
 * VAPID key decoding, in its own module because **two different bundles need
 * it**: the app (`lib/push.ts`, the gesture-driven subscribe) and the service
 * worker (`sw.ts`, the `pushsubscriptionchange` re-subscribe —
 * docs/NOTIFICATIONS.md §2.3). `lib/push.ts` can't be imported from the SW
 * (it reaches for `window` through `lib/api`), so the shared piece is this
 * one dependency-free function rather than a copy in each.
 */

/** VAPID public keys are base64url; the browser wants a Uint8Array over a plain
 *  ArrayBuffer (not SharedArrayBuffer) to satisfy applicationServerKey's type. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
