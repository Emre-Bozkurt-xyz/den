/// <reference lib="webworker" />
/**
 * Den service worker (injectManifest). Two jobs in Stage 0:
 *   1. Precache the app shell so a cold PWA start works offline-ish.
 *      ⚠️ API + WS are network-only, never cached (BACKBONE §9 checklist).
 *   2. Web Push: show notifications and deep-link on click.
 */
import { precacheAndRoute } from 'workbox-precaching';

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
  chatName?: string;
  senderName?: string;
  preview?: string;
  url?: string;
}

self.addEventListener('push', (event) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { preview: event.data?.text() };
  }
  const title = data.chatName ?? 'Den';
  const body = data.senderName ? `${data.senderName}: ${data.preview ?? ''}` : (data.preview ?? '');

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // tag groups/replaces notifications per chat; data.chatId lets the
      // message handler below address them for closing on chat-open.
      tag: data.chatId ? `chat-${data.chatId}` : undefined,
      data: { url: data.url ?? '/', chatId: data.chatId },
    }),
  );
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
    self.registration.getNotifications().then((ns) =>
      ns
        .filter((n) => (n.data as { chatId?: string } | undefined)?.chatId === chatId || n.tag === `chat-${chatId}`)
        .forEach((n) => n.close()),
    ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data as { url?: string } | undefined)?.url ?? '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window if we have one; otherwise open.
      for (const client of clients) {
        if ('focus' in client) {
          void client.focus();
          if ('navigate' in client) void client.navigate(target);
          return;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
