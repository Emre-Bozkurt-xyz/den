import type { PushConfigResponse, PushSubscribeRequest } from '@den/shared';
import { api } from './api';
import { urlBase64ToUint8Array } from './vapid';

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Hand the server whatever subscription we're holding. Idempotent by design —
 *  `POST /push/subscribe` upserts on `endpoint`, so re-registering an
 *  unchanged subscription is a no-op row update. */
async function registerSubscription(sub: PushSubscription): Promise<void> {
  const keys = sub.toJSON().keys;
  if (!keys?.p256dh || !keys.auth) throw new Error('Subscription missing encryption keys');
  const body: PushSubscribeRequest = {
    endpoint: sub.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(body) });
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

  await registerSubscription(sub);
  return sub;
}

/**
 * Re-register the subscription this browser already holds, at every app start
 * (docs/NOTIFICATIONS.md §2.3).
 *
 * Without this, a device goes **permanently silent** the moment its endpoint
 * and our `push_subscriptions` row drift apart — a push service rotating an
 * endpoint, a `410` prune racing a reinstall, a restored backup — and nothing
 * would ever reconcile it, because "Enable notifications" is a button nobody
 * presses twice. That is the slow-onset half of "I sometimes don't get
 * notifications".
 *
 * ⚠️ Deliberately incapable of prompting or subscribing. It only re-POSTs an
 * existing subscription when permission is *already* granted, so it can never
 * reach `Notification.requestPermission()` — which on iOS must come from a
 * real user gesture (PROJECT.md §12) and would be rejected (or worse, burn
 * the user's one soft ask) from here. Creating a subscription stays the
 * exclusive job of `enablePush` behind its button.
 *
 * Fire-and-forget: a failure here costs nothing that the next app start won't
 * retry, and there is no UI it could usefully report to.
 */
export async function syncPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return; // permission without a subscription — only the button can fix that
    await registerSubscription(sub);
  } catch {
    // Offline, logged out, SW evicted — all retried on the next start.
  }
}

/** Debug trigger — server sends a test notification to the caller's own subs. */
export async function sendTestPush(): Promise<{ delivered: number; total: number }> {
  return api('/api/push/test', { method: 'POST' });
}

/**
 * Tell the active service worker a chat is open so it can clear that chat's
 * already-shown notifications from the phone (sw.ts `message` handler).
 * Best-effort: no-op if there's no controlling SW yet (e.g. first load).
 */
export function clearChatNotifications(chatId: string): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.controller?.postMessage({ type: 'chat-opened', chatId });
}

/** Payload the SW posts back when a notification is tapped while the app is
 *  already running (docs/NOTIFICATIONS.md §3). */
export interface OpenChatMessage {
  type: 'open-chat';
  chatId: string;
}

/**
 * Subscribe to notification taps that arrive at an already-running app.
 * Returns an unsubscribe function.
 *
 * The SW prefers this path over `client.navigate()` precisely because
 * navigating is a **reload**: drafts, staged attachments and scroll position
 * would all die on the way to the chat the user tapped.
 */
export function onOpenChatFromNotification(handler: (chatId: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as Partial<OpenChatMessage> | undefined;
    if (data?.type === 'open-chat' && typeof data.chatId === 'string') handler(data.chatId);
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}

/**
 * App badge (docs/NOTIFICATIONS.md §5) — the count of chats with something
 * waiting, matching what the SW writes from its own notification count.
 * Unsupported browsers (and iOS below 16.4) simply have no badge; the promise
 * rejection on a denied/unsupported call is not actionable.
 */
export function setChatBadge(count: number): void {
  if (!('setAppBadge' in navigator)) return;
  void (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}
