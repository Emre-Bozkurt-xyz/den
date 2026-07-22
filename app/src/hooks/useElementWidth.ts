import { useCallback, useRef, useState } from 'react';

/**
 * Tracks an element's rendered content-box width via ResizeObserver.
 *
 * Used by the gallery masonry layouts (docs/archive/UI_REVAMP.md UI-5), which need
 * the actual measured container width — desktop's single-pane content area
 * and mobile full-screen width vary continuously, not just at the
 * `useIsMobile` breakpoint — rather than a device-class boolean.
 *
 * Uses a callback ref rather than a ref object + effect-on-mount: both
 * `ChatGallery` and `GalleryScreen` only render the measured `<div>` once
 * their data has loaded (`gridItems.length > 0` / `data.albums.length > 0`),
 * so a mount-only effect would see `ref.current === null` at the one time it
 * runs and never attach the observer. A callback ref fires every time React
 * actually attaches/detaches the node, including that later conditional
 * mount, so it always gets a real measurement.
 */
export function useElementWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((el: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return [ref, width] as const;
}
