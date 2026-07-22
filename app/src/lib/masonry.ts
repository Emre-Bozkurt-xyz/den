/**
 * Hand-rolled shortest-column masonry packing (docs/UI_REVAMP.md UI-5,
 * technique reference: Mosaic §3.3). Deliberately NOT CSS `column-count` —
 * that reflows items into reading order that doesn't match source order.
 * Predicts each item's rendered height from its already-known width/height
 * aspect ratio (MediaInfo, shared/src/api.ts) *before* the <img> loads, so
 * there's no layout pop-in once the real image arrives — the predicted box
 * and the loaded image are the same aspect ratio by construction.
 */

const FALLBACK_ASPECT_RATIO = 4 / 3; // for still-processing media with null width/height

/** Hard cap on a single tile's computed height (mosaic-style presentation
 *  retune, stage 1 of the gallery visual rework). Without this, an extreme
 *  portrait aspect ratio (e.g. a tall screenshot) can produce a tile several
 *  screens tall in a narrow column, dominating the whole grid. Images render
 *  `object-cover`, so cropping a capped tile to the container's declared
 *  height is visually seamless — no letterboxing, no distortion. */
export const MAX_TILE_HEIGHT = 600;

export interface MasonryInput {
  id: string;
  width: number | null;
  height: number | null;
}

export interface MasonryTile {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MasonryLayout {
  tiles: MasonryTile[];
  /** Height the relatively-positioned container must be given so it wraps
   *  every absolutely-positioned tile (tallest column + no trailing gap). */
  containerHeight: number;
}

/**
 * Packs `items` (kept in caller order) into `columnCount` equal-width
 * columns spanning `containerWidth`, `gap`px apart. Each item goes into
 * whichever column is *currently* shortest — real Pinterest-style packing.
 * Because columns fill independently, an item's on-screen vertical position
 * does not perfectly track its position in `items` (that's inherent to
 * shortest-column packing, not a bug) — the items array itself, and
 * everything indexed against it (viewer prev/next, jump-to-message), is
 * untouched.
 */
export function computeMasonryLayout(
  items: MasonryInput[],
  containerWidth: number,
  columnCount: number,
  gap: number,
): MasonryLayout {
  if (containerWidth <= 0 || columnCount <= 0 || items.length === 0) {
    return { tiles: [], containerHeight: 0 };
  }

  const columnWidth = (containerWidth - gap * (columnCount - 1)) / columnCount;
  const columnHeights = new Array<number>(columnCount).fill(0);
  const tiles: MasonryTile[] = [];

  for (const item of items) {
    const ratio = item.width && item.height ? item.width / item.height : FALLBACK_ASPECT_RATIO;
    const tileHeight = Math.min(columnWidth / ratio, MAX_TILE_HEIGHT);

    let shortest = 0;
    for (let c = 1; c < columnCount; c++) {
      if ((columnHeights[c] ?? 0) < (columnHeights[shortest] ?? 0)) shortest = c;
    }

    const top = columnHeights[shortest] ?? 0;
    tiles.push({ id: item.id, left: shortest * (columnWidth + gap), top, width: columnWidth, height: tileHeight });
    columnHeights[shortest] = top + tileHeight + gap;
  }

  const containerHeight = Math.max(...columnHeights) - gap;
  return { tiles, containerHeight };
}

/**
 * Column count for the per-chat media masonry grid, derived from the
 * *measured* container width (not `useIsMobile`'s device-class boolean) —
 * desktop's single-pane content area ranges continuously from ~500px to
 * well over 1400px depending on window size, not just "mobile vs desktop",
 * so column count needs its own finer-grained breakpoints. Retuned (mosaic-
 * style presentation pass, stage 1 of the gallery visual rework) to target
 * individual tiles roughly 200-300px wide, up from the original cramped
 * 110-160px — fewer, larger columns at every breakpoint.
 */
export function galleryColumnCount(containerWidth: number): number {
  if (containerWidth < 480) return 2;
  if (containerWidth < 768) return 3;
  if (containerWidth < 1100) return 4;
  return 5;
}

/**
 * Column count for the top-level album grid. Album tiles are a cover thumb
 * *plus* a name/count footer, so they read best a bit larger than an
 * individual media tile — fewer columns at the same width. Retuned alongside
 * `galleryColumnCount` (mosaic-style presentation pass, stage 1 of the
 * gallery visual rework).
 */
export function albumColumnCount(containerWidth: number): number {
  if (containerWidth < 480) return 2;
  if (containerWidth < 900) return 3;
  return 4;
}
