/**
 * PWA helpers: service-worker registration + install/standalone detection.
 * We register the SW ourselves (injectRegister: null in vite.config) so the
 * push subscribe flow can rely on `navigator.serviceWorker.ready`.
 */
import { isBusy, onBusyChange } from './busy';
import { syncPushSubscription } from './push';
import { createReloadGate } from './reloadGate';

export function isStandalone(): boolean {
  // iOS Safari exposes navigator.standalone; everyone else uses display-mode.
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iP(ad|hone|od)/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
  const webkit = /WebKit/.test(ua);
  const notChromeOrFirefox = !/CriOS|FxiOS|EdgiOS/.test(ua);
  return iOS && webkit && notChromeOrFirefox;
}

/** At most one update check per minute — `visibilitychange` fires on every
 *  app-switch, and each check is a real network request to /sw.js. */
const UPDATE_CHECK_INTERVAL_MS = 60_000;
let lastUpdateCheck = 0;

/** How long busy state must stay clear before a deferred update reload runs
 *  (see the controllerchange listener for why it isn't immediate). */
const IDLE_RELOAD_GRACE_MS = 2_000;
const reloadGate = createReloadGate({
  isUploading: () => isBusy('upload'),
  isBusy: () => isBusy(),
  isHidden: () => document.visibilityState === 'hidden',
  reload: () => window.location.reload(),
});
let watchingBusy = false;
let idleTimer: number | undefined;

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  // Read BEFORE registering: null on a first-ever visit (nothing controls the
  // page yet), non-null on every subsequent load. `clients.claim()` fires
  // `controllerchange` in both cases, and only the second one means "a new
  // version just replaced the one this page is running".
  const hadController = navigator.serviceWorker.controller !== null;

  try {
    // vite-plugin-pwa serves the built SW at /sw.js (module in dev).
    const registration = await navigator.serviceWorker.register(
      import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js',
      { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' },
    );

    // ⚠️ An installed PWA can go days without a navigation, and a navigation
    // is the only thing that triggers an update check by default. iOS is the
    // acute case: the app is resumed from the background rather than
    // cold-launched, so without this a deploy could stay invisible
    // indefinitely. Check on every foreground instead.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
      lastUpdateCheck = now;
      void registration.update().catch(() => {
        // Registration gone (unregistered/evicted) — nothing to update, and
        // there's no useful recovery from a failed background check.
      });
    });

    // sw.ts calls skipWaiting() + clients.claim(), so a new worker takes over
    // this page while it is still running the OLD JS bundle — which both hides
    // the update and risks the stale page requesting chunks that no longer
    // exist. Reload once so the new code actually loads.
    //
    // …but not on top of something a reload would destroy (`lib/busy.ts`): an
    // upload in flight, or a draft / staged attachments / a recording in the
    // composer. `lib/reloadGate.ts` holds the rule; this wires it to the
    // events that can unblock it — busy state dropping, and the page going
    // hidden (which overrides composer content, never an upload).
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (!watchingBusy) {
        watchingBusy = true;
        onBusyChange(() => {
          // A grace period, not an immediate re-check: a release is often
          // followed straight away by a new hold (the retry path's re-mint
          // after `retryAlbumItems` returns), and a text Send clears the
          // draft in the same tick it emits over the socket — reloading right
          // there could drop that frame before it leaves. Re-evaluated when
          // the timer fires, so it never reloads into a hold that appeared
          // in between.
          if (idleTimer !== undefined) window.clearTimeout(idleTimer);
          idleTimer = window.setTimeout(() => {
            idleTimer = undefined;
            reloadGate.attempt();
          }, IDLE_RELOAD_GRACE_MS);
        });
      }
      reloadGate.request();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') reloadGate.attempt();
    });

    // Re-register whatever push subscription this browser already holds
    // (docs/NOTIFICATIONS.md §2.3). Never prompts, never subscribes — see
    // `syncPushSubscription`'s doc for why it structurally can't. Fire and
    // forget: it has no UI and the next start retries.
    void syncPushSubscription();
  } catch (err) {
    console.error('SW registration failed', err);
  }
}
