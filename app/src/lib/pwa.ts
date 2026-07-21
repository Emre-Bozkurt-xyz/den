/**
 * PWA helpers: service-worker registration + install/standalone detection.
 * We register the SW ourselves (injectRegister: null in vite.config) so the
 * push subscribe flow can rely on `navigator.serviceWorker.ready`.
 */

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
let reloading = false;

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
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true;
      window.location.reload();
    });
  } catch (err) {
    console.error('SW registration failed', err);
  }
}
