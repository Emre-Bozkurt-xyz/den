import { useEffect, useState } from 'react';

// Keep in sync with the CSS media query below — Tailwind's own `md:` breakpoint
// is also 768, so component-tree branching and any CSS-utility sizing line up
// on the same pixel value instead of introducing a second magic number
// (docs/UI_REVAMP.md §4.2).
const MOBILE_MAX_WIDTH = 768;
const QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

/**
 * Structural (not just cosmetic) mobile/desktop signal. Per §4.2/§4.3,
 * components branch their *component tree* on this — not just styling — so
 * it needs to update live and be readable synchronously on first render (no
 * flash of the wrong layout). Subscribes to the media query's own `change`
 * event rather than a window resize listener + manual width comparison.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Re-sync in case the viewport changed between the initial useState
    // evaluation and this effect's mount.
    setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
