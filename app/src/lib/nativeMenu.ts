import type { MouseEvent as ReactMouseEvent } from 'react';

/** Swallows the `contextmenu` event a touch/pen long-press produces on
 *  Android Chrome (the save-image / share sheet), for media *previews* —
 *  gallery tiles, chat thumbnails, media stacks — where long-press is an app
 *  gesture (multi-select / focus menu) and the native menu fights it
 *  (PROJECT.md §14 2026-07-22).
 *
 *  Desktop right-click keeps the native menu: Chrome delivers contextmenu as
 *  a PointerEvent whose pointerType distinguishes mouse from touch, and
 *  browsers that still deliver a plain MouseEvent (no pointerType) fall
 *  through untouched. iOS Safari never fires contextmenu for touch at all —
 *  its long-press callout + selection loupe are suppressed in CSS by
 *  `.media-preview` (index.css). The class and this handler ship as a pair:
 *  every element with one gets the other.
 *
 *  The full-screen MediaViewer gets neither — full display is exactly where
 *  the native save/share behavior belongs. */
export function suppressTouchContextMenu(e: ReactMouseEvent) {
  const native = e.nativeEvent as MouseEvent & Partial<Pick<PointerEvent, 'pointerType'>>;
  if (native.pointerType === 'touch' || native.pointerType === 'pen') e.preventDefault();
}
