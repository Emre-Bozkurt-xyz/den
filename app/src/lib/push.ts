import type { PushConfigResponse, PushSubscribeRequest } from '@den/shared';
import { api } from './api';

/** VAPID public keys are base64url; the browser wants a Uint8Array over a plain
 *  ArrayBuffer (not SharedArrayBuffer) to satisfy applicationServerKey's type. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Full subscribe flow. MUST be called from a user gesture on iOS — the
 * permission prompt is gesture-gated in the installed PWA (BACKBONE §8).
 */
export async function enablePush(): Promise<PushSubscription> {
  if (!pushSupported()) throw new Error('Push not supported in this browser');

  const reg = await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(`Permission ${permission}`);

  const { vapidPublicKey } = await api<PushConfigResponse>('/api/push/config');

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const keys = sub.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) throw new Error('Subscription missing encryption keys');
  const body: PushSubscribeRequest = {
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(body) });
  return sub;
}

/** Debug trigger — server sends a test notification to the caller's own subs. */
export async function sendTestPush(): Promise<{ delivered: number; total: number }> {
  return api('/api/push/test', { method: 'POST' });
}
