import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Live `prefers-reduced-motion` signal for the hand-rolled *JS-driven*
 * animations (UI-8d's focus-menu lift, UI-8e's composer↔recording-bar morph,
 * docs/UI8_CHAT_INSTAGRAM.md §4) — ones built from inline `transition`/
 * `transform` styles rather than a pure CSS `@keyframes` rule. UI-8a's
 * bubble-in doesn't need this: it degrades via a plain `@media
 * (prefers-reduced-motion: reduce)` override right next to the keyframe in
 * index.css. Mirrors `useIsMobile`'s matchMedia-subscription shape.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(QUERY).matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    setReduced(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
