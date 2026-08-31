import type { CSSProperties } from 'react';
import { Loader2, Play, TriangleAlert } from 'lucide-react';
import type { MediaInfo } from '@den/shared';
import { useIsBlurred, useSensitivity } from '../lib/sensitivity';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { PreviewImage } from './PreviewImage';
import { SensitiveOverlay } from './SensitiveOverlay';

/**
 * Fixed-width mosaic card for an album (`Message.media.length > 1`,
 * docs/MEDIA_ATTACHMENTS.md §5.3/D2). Square, `object-cover` tiles with 2px
 * gutters; the caption strip from §5.3 is appended below when the message
 * has a body, using the same bubble-fill colors as a captioned single photo
 * so the two read as the same kind of object.
 *
 * A **fixed pixel width**, not "image display width" (unlike the captioned
 * single-media container) — a mosaic has no one image's aspect ratio to
 * follow, and `ALBUM_CARD_WIDTH` is picked to sit comfortably inside the
 * chat's `max-w-[78%]` run column at typical phone widths, matching the
 * ~288px (`max-h-72`) footprint bare single media already uses.
 */

const ALBUM_CARD_WIDTH = 288;
const GUTTER = 2;

/** One tile's position within the card, in pixels — precomputed per layout
 *  below rather than left to CSS grid math, so every N (2–10) can have its
 *  own genuinely different shape (§5.3's table) instead of forcing all of
 *  them through one generic N-column grid. */
interface TileRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Layout {
  height: number;
  tiles: TileRect[];
}

/** §5.3's layout table, N=2..6 (7-10 reuse the 6-tile layout with the 6th
 *  tile turned into a "+N" overflow — see `layoutFor`). */
function layoutFor(n: number): Layout {
  const W = ALBUM_CARD_WIDTH;
  if (n === 2) {
    const w = (W - GUTTER) / 2;
    return {
      height: w,
      tiles: [
        { left: 0, top: 0, width: w, height: w },
        { left: w + GUTTER, top: 0, width: w, height: w },
      ],
    };
  }
  if (n === 3) {
    // Big tile 2×2 left + two 1×1 stacked right.
    const rightW = (W - 2 * GUTTER) / 3;
    const leftW = W - GUTTER - rightW;
    return {
      height: leftW,
      tiles: [
        { left: 0, top: 0, width: leftW, height: leftW },
        { left: leftW + GUTTER, top: 0, width: rightW, height: rightW },
        { left: leftW + GUTTER, top: rightW + GUTTER, width: rightW, height: rightW },
      ],
    };
  }
  if (n === 4) {
    const w = (W - GUTTER) / 2;
    return {
      height: 2 * w + GUTTER,
      tiles: [
        { left: 0, top: 0, width: w, height: w },
        { left: w + GUTTER, top: 0, width: w, height: w },
        { left: 0, top: w + GUTTER, width: w, height: w },
        { left: w + GUTTER, top: w + GUTTER, width: w, height: w },
      ],
    };
  }
  if (n === 5) {
    // Two 3-unit tiles on top, three 2-unit tiles below (6-unit grid).
    const topW = (W - GUTTER) / 2;
    const botW = (W - 2 * GUTTER) / 3;
    return {
      height: topW + GUTTER + botW,
      tiles: [
        { left: 0, top: 0, width: topW, height: topW },
        { left: topW + GUTTER, top: 0, width: topW, height: topW },
        { left: 0, top: topW + GUTTER, width: botW, height: botW },
        { left: botW + GUTTER, top: topW + GUTTER, width: botW, height: botW },
        { left: 2 * (botW + GUTTER), top: topW + GUTTER, width: botW, height: botW },
      ],
    };
  }
  // 6 (and the base for 7–10, see below): 3×2.
  const w = (W - 2 * GUTTER) / 3;
  return {
    height: 2 * w + GUTTER,
    tiles: [
      { left: 0, top: 0, width: w, height: w },
      { left: w + GUTTER, top: 0, width: w, height: w },
      { left: 2 * (w + GUTTER), top: 0, width: w, height: w },
      { left: 0, top: w + GUTTER, width: w, height: w },
      { left: w + GUTTER, top: w + GUTTER, width: w, height: w },
      { left: 2 * (w + GUTTER), top: w + GUTTER, width: w, height: w },
    ],
  };
}

export function AlbumCard({
  media,
  body,
  mine,
  isRunHead,
  interactive = true,
  onOpenViewer,
  onOpenOverflow,
  onCaptionClick,
}: {
  /** All of the message's items, in stage order (server: media id ASC). */
  media: MediaInfo[];
  body: string | null;
  mine: boolean;
  /** §5.3 — corner-tightening for the container follows the same
   *  run-position rule as a captioned single-media card. */
  isRunHead: boolean;
  interactive?: boolean;
  /** Tap on any of the up-to-6 visible tiles (never the "+N" tile). */
  onOpenViewer: (index: number) => void;
  /** Tap on the "+N" overlay (7–10 items only) — opens the existing
   *  `MediaGridSheet` over the whole album, per §5.3. */
  onOpenOverflow: () => void;
  /** Clicks on the caption strip. The strip is not a media tap, so it routes
   *  back to the block's generic click path to get double-tap-to-react and
   *  selection-toggle, exactly like a plain text bubble (owner report,
   *  2026-08-12 — it used to be inert). */
  onCaptionClick?: (e: React.MouseEvent) => void;
}) {
  const { reveal } = useSensitivity();
  const visibleCount = Math.min(media.length, 6);
  const layout = layoutFor(visibleCount);
  const overflow = media.length > 6 ? media.length - 5 : 0;

  // Container radius = the radius bare media uses today (rounded-md — see
  // MediaBubble), with the same sender-side run-position corner tightening
  // the caption container uses (docs §5.3), applied to this card's outer
  // wrapper. Media loses its own radius; this wrapper's `overflow-hidden`
  // does the clipping.
  const cornerClass = isRunHead ? '' : mine ? 'rounded-tr-[4px]' : 'rounded-tl-[4px]';
  const bottomCornerClass = mine ? 'rounded-br-[4px]' : 'rounded-bl-[4px]';

  return (
    <div
      className={'overflow-hidden rounded-md ' + cornerClass + ' ' + bottomCornerClass}
      style={{ width: ALBUM_CARD_WIDTH }}
    >
      <div className="relative" style={{ width: ALBUM_CARD_WIDTH, height: layout.height }}>
        {media.slice(0, visibleCount).map((item, i) => {
          const rect = layout.tiles[i]!;
          const isOverflowTile = overflow > 0 && i === visibleCount - 1;
          return (
            <AlbumTile
              key={item.id}
              media={item}
              rect={rect}
              interactive={interactive}
              overflowCount={isOverflowTile ? overflow : 0}
              onOpen={() => (isOverflowTile ? onOpenOverflow() : onOpenViewer(i))}
              onRevealAlbum={() => reveal(media.filter((m) => m.sensitivity !== null).map((m) => m.id))}
            />
          );
        })}
      </div>
      {body && (
        <div
          onClick={onCaptionClick}
          className={'relative px-3.5 py-2 text-sm ' + (mine ? 'bg-accent text-white' : 'bg-surface-sunken text-text-primary')}
        >
          <p className="whitespace-pre-wrap break-words">{body}</p>
        </div>
      )}
    </div>
  );
}

function AlbumTile({
  media,
  rect,
  interactive,
  overflowCount,
  onOpen,
  onRevealAlbum,
}: {
  media: MediaInfo;
  rect: TileRect;
  interactive: boolean;
  /** > 0 for the 6th tile of a 7–10 item album — draws the "+N" overlay. */
  overflowCount: number;
  onOpen: () => void;
  /** docs §5.4/§5.8 — revealing any blurred tile of an album reveals every
   *  blurred tile in the album (they were composed and marked together);
   *  passed down instead of just `reveal(media.id)` so a single tap does the
   *  whole batch. */
  onRevealAlbum: () => void;
}) {
  const blurred = useIsBlurred(media);
  const style: CSSProperties = {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };

  // A tile that isn't `ready` yet has no thumbnail to draw, and until this
  // existed it rendered a bare `<img>` with `src={undefined}` — an empty box
  // that looked identical to a slow-loading photo, sat there indefinitely, and
  // opened nothing when tapped (owner report, 2026-08-31: "just a blank image
  // till it fully loads" / "videos are hard to open"). A single photo/video has
  // said "Processing…" since docs/MEDIA_ATTACHMENTS.md §4.6 (see MediaBubble);
  // an album's tiles were simply never given the same treatment. Video is the
  // visible case because transcoding takes far longer than an image resize.
  //
  // Deliberately drawn *before* the SensitiveOverlay: there are no real bytes
  // on screen to blur, and blurring a spinner would only make the state harder
  // to read. The tap is inert too — `ChatView.openAlbumViewer` refuses
  // non-ready items, so a placeholder that looked tappable would be a lie.
  // Clicks still bubble to the block wrapper, which is what keeps the tile
  // selectable in multi-select.
  //
  // The "+N" overflow tile is exempt: its job is to say how many more items
  // there are and open the grid sheet, which it can still do with nothing
  // underneath it. Replacing it with a processing placeholder would strand the
  // 7th–10th items with no way in.
  if (media.status !== 'ready' && overflowCount === 0) {
    const failed = media.status === 'failed';
    return (
      <div style={style}>
        <div
          className={
            'flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-[10px] leading-tight ' +
            (failed ? 'bg-red-500/10 text-red-500' : 'bg-surface-sunken text-text-muted')
          }
        >
          {failed ? <TriangleAlert size={14} /> : <Loader2 size={14} className="animate-spin" />}
          {/* The smallest tile in the §5.3 table is ~95px wide (the 3×2
              layout), which still fits one short word per line. */}
          <span>{failed ? 'Failed' : media.kind === 'video' ? 'Processing video' : 'Processing'}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={style}>
      <SensitiveOverlay
        sensitivity={media.sensitivity}
        blurred={blurred}
        onReveal={onRevealAlbum}
        compact
        className="h-full w-full"
        // Selection mode owns every tap (the block wrapper toggles selection).
        // Without this the overlay would swallow the tap to reveal instead,
        // making blurred tiles un-selectable — same reason the tile button
        // below goes `disabled`.
        interactive={interactive}
      >
        <button
          type="button"
          onClick={interactive ? onOpen : undefined}
          onContextMenu={suppressTouchContextMenu}
          disabled={!interactive}
          className="media-preview relative block h-full w-full"
          style={{ touchAction: 'manipulation' }}
        >
          <PreviewImage
            media={media}
            src={media.thumbUrl ?? media.url ?? undefined}
            alt=""
            className="h-full w-full object-cover"
          />
          {overflowCount === 0 && media.kind === 'video' && (
            <span className="pointer-events-none absolute inset-0 grid place-items-center">
              <span className="grid h-8 w-8 place-items-center rounded-pill bg-black/50 text-white">
                <Play size={14} fill="currentColor" />
              </span>
            </span>
          )}
          {overflowCount > 0 && (
            <span className="absolute inset-0 grid place-items-center bg-black/50 text-lg font-semibold text-white">
              +{overflowCount}
            </span>
          )}
        </button>
      </SensitiveOverlay>
    </div>
  );
}
