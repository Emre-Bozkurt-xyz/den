import { useEffect, useState } from 'react';
import { isIosSafari } from '../lib/pwa';

/**
 * docs/IOS_KEYBOARD.md — tracks how far the on-screen keyboard intrudes into
 * the *visible* (visualViewport) region, so a bottom-anchored composer can
 * stay pinned above it instead of hiding behind it.
 *
 * iOS Safari never resizes the *layout* viewport for the keyboard — it
 * overlays the page instead, so `100dvh` / `env(safe-area-inset-bottom)` are
 * blind to it. Only `window.visualViewport` sees the keyboard:
 *
 *   keyboardInset = window.innerHeight - visualViewport.height - visualViewport.offsetTop
 *
 * clamped to `>= 0`.
 *
 * ⚠️ iOS-gated (`isIosSafari`, lib/pwa.ts — true for both mobile Safari and
 * the installed PWA, which share the same WebKit UA). Android/Chrome and
 * desktop already resize the *layout* viewport for the keyboard, so this
 * hook is a hard no-op there: `--kb-inset` is never written and this always
 * returns 0, leaving today's `env(safe-area-inset-bottom)` styling
 * byte-for-byte unchanged. Engaging it off-iOS would double-count the inset
 * and shove the composer up by a keyboard's height into empty space
 * (docs/IOS_KEYBOARD.md §3).
 *
 * Listens to both `resize` and `scroll` on `visualViewport` — iOS fires
 * `scroll` too as the viewport pans during the keyboard's open/close
 * animation and when switching between the system keyboard, the emoji
 * keyboard, and third-party keyboards. Both handlers coalesce into one
 * computation per animation frame (iOS fires them rapidly).
 *
 * Also mirrors the same value onto `--kb-inset` (px, on
 * `document.documentElement`) so a consumer can position with plain CSS
 * (`var(--kb-inset)`) and track the live value smoothly without waiting for
 * this hook's own state update to flow through a re-render.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !isIosSafari()) return; // gate off — leave today's safe-area-only path untouched

    let rafId: number | null = null;

    function apply() {
      rafId = null;
      const next = Math.max(0, Math.round(window.innerHeight - vv!.height - vv!.offsetTop));
      document.documentElement.style.setProperty('--kb-inset', `${next}px`);
      setInset(next);
    }

    function onViewportChange() {
      if (rafId !== null) return; // already queued for this frame
      rafId = requestAnimationFrame(apply);
    }

    apply(); // sync immediately — covers mounting while the keyboard is already up (e.g. orientation change)
    vv.addEventListener('resize', onViewportChange);
    vv.addEventListener('scroll', onViewportChange);
    return () => {
      vv.removeEventListener('resize', onViewportChange);
      vv.removeEventListener('scroll', onViewportChange);
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.documentElement.style.removeProperty('--kb-inset');
      setInset(0);
    };
  }, []);

  return inset;
}
