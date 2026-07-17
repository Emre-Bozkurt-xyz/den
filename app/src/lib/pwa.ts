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

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    // vite-plugin-pwa serves the built SW at /sw.js (module in dev).
    await navigator.serviceWorker.register(
      import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js',
      { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' },
    );
  } catch (err) {
    console.error('SW registration failed', err);
  }
}
