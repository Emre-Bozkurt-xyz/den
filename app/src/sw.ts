/// <reference lib="webworker" />
/**
 * Den service worker (injectManifest). Three jobs:
 *   1. Precache the app shell so a cold PWA start works offline-ish.
 *      ⚠️ API + WS are network-only, never cached (BACKBONE §9 checklist).
 *   2. Web Push: show notifications, deep-link on click, clear on chat-open.
 *   3. Keep the push subscription alive across endpoint rotation.
 *
 * Revised 2026-08-23 — docs/NOTIFICATIONS.md.
 */
import { precacheAndRoute } from 'workbox-precaching';
import { urlBase64ToUint8Array } from './lib/vapid';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

// App-shell precache list injected at build time. API responses are NOT here.
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener('install', () => {
  void self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

interface PushPayload {
  chatId?: string;
  /** Group name (recipient-relative). Absent/null for a DM — see `titleFor`. */
  chatName?: string | null;
  senderName?: string;
  preview?: string;
  url?: string;
}

/** `renotify` and `timestamp` are real, long-shipped Notification options that
 *  TypeScript's `NotificationOptions` (lib.dom, TS 5.9) still doesn't declare —
 *  it models the `Notification` *constructor*, not `showNotification`. */
interface ShowNotificationOptions extends NotificationOptions {
  renotify?: boolean;
  timestamp?: number;
}

const chatTag = (chatId: string): string => `chat-${chatId}`;

/**
 * DM: the sender IS the conversation, so their name is the title and the body
 * is just what they said. Group: the group is the title and the body needs the
 * `Sender:` prefix to say who spoke (docs/NOTIFICATIONS.md §6).
 */
function titleFor(data: PushPayload): { title: string; body: string } {
  const preview = data.preview ?? '';
  if (data.chatName) return { title: data.chatName, body: data.senderName ? `${data.senderName}: ${preview}` : preview };
  return { title: data.senderName ?? 'Den', body: preview };
}

/**
 * App badge (docs/NOTIFICATIONS.md §5 / D4). Counted from the notifications
 * currently on screen, which — because each chat collapses onto one `tag` — is
 * the same unit the app itself writes from the `['chats']` query: *chats with
 * something waiting*, not messages. The SW has no way to know a message count,
 * and two writers disagreeing about what the number means is worse than a
 * coarser number both can produce.
 */
async function refreshBadge(): Promise<void> {
  if (!('setAppBadge' in navigator)) return;
  try {
    const shown = await self.registration.getNotifications();
    await (shown.length > 0 ? navigator.setAppBadge(shown.length) : navigator.clearAppBadge());
  } catch {
    // Badging is decoration; never let it break the push handler.
  }
}

self.addEventListener('push', (event) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { preview: event.data?.text() };
  }
  const { title, body } = titleFor(data);

  const options: ShowNotificationOptions = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    // tag groups/replaces notifications per chat; data.chatId lets the
    // message handler below address them for closing on chat-open.
    tag: data.chatId ? chatTag(data.chatId) : undefined,
    // ⚠️ Without this, a replacement lands **silently** — no sound, no
    // vibration, no banner — so messages 2..N of a burst are invisible unless
    // the user happens to look at the tray. That is a large share of "I
    // sometimes don't get notifications" (docs/NOTIFICATIONS.md §2.2).
    // Requires `tag`, which is why it is set alongside it.
    renotify: data.chatId ? true : undefined,
    timestamp: Date.now(),
    data: { url: data.url ?? '/', chatId: data.chatId },
  };

  event.waitUntil(self.registration.showNotification(title, options).then(refreshBadge));
});

/**
 * Client tells us a chat became active (ChatView mount / becoming visible)
 * so we can clear that chat's already-shown notifications from the phone.
 * ⚠️ iOS note: programmatic dismissal via getNotifications() is historically
 * unreliable in installed iOS PWAs — this is best-effort; flag for the
 * iPhone device gate.
 */
self.addEventListener('message', (event) => {
  const data = event.data as { type?: string; chatId?: string } | undefined;
  if (data?.type !== 'chat-opened' || !data.chatId) return;
  const chatId = data.chatId;
  event.waitUntil(
    self.registration
      .getNotifications()
      .then((ns) =>
        ns
          .filter((n) => (n.data as { chatId?: string } | undefined)?.chatId === chatId || n.tag === chatTag(chatId))
          .forEach((n) => n.close()),
      )
      .then(refreshBadge),
  );
});

/**
 * Tap → the chat it came from (docs/NOTIFICATIONS.md §3).
 *
 * Two paths, and the split is the whole point. A running client is **messaged,
 * not navigated**: `client.navigate()` is a real navigation even to the URL
 * already loaded, so the old code's `navigate('/')` reloaded the PWA and threw
 * away drafts, staged attachments and scroll position on the way to dumping
 * the user on the chat list. Only a cold start gets a URL, and `?chat=` is a
 * launch parameter App.tsx consumes once and wipes — Den has no router.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, chatId } = (event.notification.data ?? {}) as { url?: string; chatId?: string };
  const target = url ?? '/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const client = clients[0];
      if (client) {
        await client.focus();
        if (chatId) client.postMessage({ type: 'open-chat', chatId });
        // No chatId (a test push) — nothing to route to, focusing is the whole
        // action. Still no navigate(): a reload would be a worse outcome than
        // landing wherever the user already was.
      } else {
        await self.clients.openWindow(target);
      }
      await refreshBadge();
    })(),
  );
});

self.addEventListener('notificationclose', () => {
  // Dismissing from the tray is the user saying they've dealt with it.
  void refreshBadge();
});

/**
 * The push service rotated our endpoint (docs/NOTIFICATIONS.md §2.3).
 *
 * Nothing else covers this: the old subscription stops receiving, the server
 * keeps sending to a dead endpoint, and because the browser never tells the
 * page, that device stays **silent forever** until someone happens to tap
 * "Enable notifications" again. `lib/push.ts`'s `syncPushSubscription()` is
 * the belt to this pass's braces — it re-registers on every app start, which
 * catches the case where this event fired while no page was open to hear it.
 *
 * Re-subscribing needs the VAPID key, so it is fetched fresh from
 * `/push/config` (unauthenticated by design) rather than cached here — a
 * stale key is exactly the thing that would make this fail silently.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  // The event's own typing is not in lib.dom (it models this as a bare Event);
  // `newSubscription` is populated by some browsers and absent in others, so
  // both paths exist.
  const e = event as ExtendableEvent & { newSubscription?: PushSubscription };
  event.waitUntil(
    (async () => {
      try {
        let sub = e.newSubscription ?? null;
        if (!sub) {
          const res = await fetch('/api/push/config');
          if (!res.ok) return;
          const { vapidPublicKey } = (await res.json()) as { vapidPublicKey: string };
          sub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
          });
        }
        const keys = sub.toJSON().keys;
        if (!keys?.p256dh || !keys.auth) return;
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Same-origin, so the session cookie rides along and the route's
          // requireAuth is satisfied without any token plumbing.
          credentials: 'include',
          body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
        });
      } catch {
        // Offline or logged out — the app-start sync retries.
      }
    })(),
  );
});
