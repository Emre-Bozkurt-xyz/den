import { useCallback, useRef, useState } from 'react';

/**
 * Reports once (and only once) that an element has entered the viewport, or
 * come within `rootMargin` of it. Used to gate the Stage's paper-thumbnail
 * fetch (docs/EMBEDS.md §6.2.1: "fetch thumbnails lazily ... do not fire one
 * render request per card on mount") — a Stage with dozens of docs should
 * fire a handful of `/rendered` requests as the user scrolls, not one burst
 * on mount.
 *
 * Callback ref, same shape as `useElementWidth` — both `ChatGallery`/
 * `GalleryScreen`'s measured grids and this only render their target
 * conditionally, so a mount-only effect would sometimes see `ref.current
 * === null` at the one time it runs.
 *
 * Deliberately latches `true` and disconnects rather than toggling on
 * scroll-out: a card that already fetched its thumbnail shouldn't drop it
 * and refetch just because it scrolled off-screen and back.
 */
export function useInView<T extends HTMLElement>(rootMargin = '200px') {
  const [inView, setInView] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const ref = useCallback(
    (el: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        },
        { rootMargin },
      );
      observer.observe(el);
      observerRef.current = observer;
    },
    [rootMargin],
  );

  return [ref, inView] as const;
}
