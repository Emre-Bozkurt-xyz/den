import { Eye, Layers, Loader2, Play, TriangleAlert, X } from 'lucide-react';
import type { MediaInfo, Message } from '@den/shared';
import { useBackHandler } from '../lib/backStack';
import { blurredIdsOf, useIsBlurred, useSensitivity } from '../lib/sensitivity';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { MediaPlaceholder } from './MediaBubble';
import { PreviewImage } from './PreviewImage';
import { SensitiveOverlay } from './SensitiveOverlay';

/**
 * Fanned photo/video stack (docs/archive/UI_REVAMP.md UI-7).
 *
 * Several bare media messages sent back-to-back are drawn as a small pile of
 * cards rather than a vertical column of thumbnails — the top card at full
 * size, the ones behind it peeking out at a slight angle. Tapping opens a
 * grid sheet listing every item in the stack; tapping one of those opens the
 * normal full-screen `MediaViewer`.
 *
 * A stack is *purely* presentational: each card is still its own message on
 * the wire (see lib/messageGroups.ts). Selection/deletion never operate on a
 * stack as a unit — entering multi-select expands it back into individual
 * bubbles, and long-pressing a stack selects all of its messages
 * individually. Nothing here can produce an action scoped to "the stack".
 *
 * A **fan is not an album** (docs/MEDIA_ATTACHMENTS.md D4): it's several
 * separate sends grouped by proximity, each independently addressable — so,
 * unlike an album's mosaic, revealing a blurred stack doesn't batch-reveal
 * its siblings. The top card reveals just itself; the grid sheet's explicit
 * "Reveal all" is the deliberate opt-in for the whole pile (§5.4).
 */

/** Rotation/offset of the cards *behind* the top one, back to front. Kept
 *  deliberately small — this is a hint of depth, not a fan of playing cards.
 *  Only two are ever drawn no matter how large the stack; the badge carries
 *  the real count. */
const BACK_CARDS = [
  { rotate: -5, x: -6, y: 5 },
  { rotate: 3.5, x: 5, y: 3 },
] as const;

/** The poster to draw for a stack card, or `undefined` when there is nothing
 *  to draw yet.
 *
 *  Gated on `status` rather than just falling back through the URLs: for an
 *  item that is still processing both are null, and for one that is *mid*
 *  processing `url` can be the raw upload — a video file, which in an `<img>`
 *  is a broken image rather than a poster. Callers treat `undefined` as "draw
 *  the placeholder", so this is the single place that decides it. */
function thumbOf(m: Message): string | undefined {
  const media = m.media[0];
  if (!media || media.status !== 'ready') return undefined;
  return media.thumbUrl ?? media.url ?? undefined;
}

export function MediaStack({ messages, onOpen }: { messages: Message[]; onOpen: () => void }) {
  const { reveal } = useSensitivity();
  const [top, ...rest] = messages;
  const topMedia = top?.media[0] ?? null;
  const topBlurred = useIsBlurred(topMedia ?? { id: '', sensitivity: null });
  if (!top || !topMedia) return null;
  // Back cards are drawn from the *end* of the stack so the card immediately
  // behind the top one is the next item, not the last.
  const backs = rest.slice(0, BACK_CARDS.length);

  return (
    <div
      className="media-preview relative w-fit cursor-pointer"
      onClick={onOpen}
      onContextMenu={suppressTouchContextMenu}
      style={{ touchAction: 'manipulation' }}
    >
      {backs.map((m, i) => {
        const thumb = thumbOf(m);
        // inset-0 resolves against the box the in-flow top card establishes
        // below, so the pile always matches the top card's dimensions.
        // `key` is passed explicitly at each call below, never through this
        // object — React 19 warns when a spread props object carries one.
        const shared = {
          'aria-hidden': true,
          className: 'absolute inset-0 h-full w-full rounded-md object-cover shadow-soft',
          style: {
            transform: `translate(${BACK_CARDS[i]!.x}px, ${BACK_CARDS[i]!.y}px) rotate(${BACK_CARDS[i]!.rotate}deg)`,
            zIndex: 0,
          },
        };
        // A sibling that hasn't finished processing has no poster, and an
        // `<img>` with no `src` is an invisible card — the pile silently loses
        // its depth and stops reading as a pile at all. A blank fill keeps the
        // shape; the count badge and the grid sheet carry the real information.
        return thumb ? (
          <img key={m.id} {...shared} src={thumb} alt="" />
        ) : (
          <div key={m.id} {...shared} className={shared.className + ' bg-surface-sunken'} />
        );
      })}
      {/* In-flow top card establishes the pile's box — reserve it pre-load so
          the open-chat scroll-to-bottom isn't measuring a collapsed stack.
          Blur is scoped to this one item only (a fan's items are
          independently addressable, D4) — tapping the reveal pill reveals
          just the top card, not the whole pile. */}
      {topMedia.status !== 'ready' ? (
        // Same treatment a single photo/video has had since
        // docs/MEDIA_ATTACHMENTS.md §4.6, and the same shared card an album's
        // tiles now draw their compact version of: without it a fan whose top
        // item was still transcoding showed an empty frame with no explanation
        // and no indication it would ever fill in (owner report, 2026-08-31).
        // No `SensitiveOverlay` — there are no bytes on screen to blur yet, and
        // blurring a spinner only makes the state harder to read. The pile
        // stays tappable: the grid sheet behind it may hold items that ARE
        // ready, and it now labels the ones that aren't.
        <div className="relative z-10">
          <MediaPlaceholder media={topMedia} />
        </div>
      ) : (
        <SensitiveOverlay
          sensitivity={topMedia.sensitivity}
          blurred={topBlurred}
          onReveal={() => reveal(topMedia.id)}
          className="relative z-10"
        >
          <PreviewImage media={top.media[0]} src={thumbOf(top)} alt="" className="max-h-72 max-w-full rounded-md object-cover" />
        </SensitiveOverlay>
      )}
      <span className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-pill bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
        <Layers size={12} />
        {messages.length}
      </span>
    </div>
  );
}

/** One tile in the grid sheet below — its own `SensitiveOverlay` (blur is
 *  per item, docs §5.4/§5.8) so a clean tile in the pile is never hidden
 *  because a sibling is marked. */
function GridTile({ media, thumbUrl, onClick }: { media: MediaInfo; thumbUrl: string | undefined; onClick: () => void }) {
  const { reveal } = useSensitivity();
  const blurred = useIsBlurred(media);
  // Matches `AlbumCard`'s mosaic tile: an item that isn't ready has no
  // thumbnail, so without this it drew an empty square that opened nothing.
  // Inert rather than tappable — ChatView's `onPick` refuses non-ready items.
  if (media.status !== 'ready') {
    const failed = media.status === 'failed';
    return (
      <div
        className={
          'flex aspect-square flex-col items-center justify-center gap-1 rounded-sm px-1 text-center text-[10px] leading-tight ' +
          (failed ? 'bg-red-500/10 text-red-400' : 'bg-white/5 text-white/60')
        }
      >
        {failed ? <TriangleAlert size={14} /> : <Loader2 size={14} className="animate-spin" />}
        <span>{failed ? 'Failed' : media.kind === 'video' ? 'Processing video' : 'Processing'}</span>
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      onContextMenu={suppressTouchContextMenu}
      className="media-preview relative aspect-square overflow-hidden rounded-sm bg-white/5"
      style={{ touchAction: 'manipulation' }}
    >
      <SensitiveOverlay sensitivity={media.sensitivity} blurred={blurred} onReveal={() => reveal(media.id)} compact className="h-full w-full">
        <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
      </SensitiveOverlay>
      {media.kind === 'video' && (
        <span className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid h-9 w-9 place-items-center rounded-pill bg-black/50 text-white">
            <Play size={16} fill="currentColor" />
          </span>
        </span>
      )}
    </button>
  );
}

/** Grid sheet listing every item passed to it. Deliberately a plain square
 *  grid (not the gallery's masonry) — this is a handful of items from one
 *  moment, and uniform tiles make "which one do I want" the only question on
 *  screen. Takes `MediaInfo[]` directly (not `Message[]`) as of
 *  docs/MEDIA_ATTACHMENTS.md §5.3/§5.7 — a legacy stack's caller derives one
 *  `MediaInfo` per message (`thumbOf`/`m.media[0]`), while `AlbumCard`'s "+N"
 *  overflow tile hands this the same message's `media` array directly (all N
 *  items already belong to one message, so there's no per-message thumbUrl
 *  lookup to do). */
export function MediaGridSheet({
  items,
  onPick,
  onClose,
}: {
  items: { media: MediaInfo; thumbUrl: string | undefined }[];
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  const { isRevealed, reveal } = useSensitivity();
  // System back gesture / browser back closes the sheet (matches the X and the
  // backdrop tap), instead of unwinding the chat → chat list. Opening the
  // viewer from a tile registers the viewer's own handler on top (LIFO), so
  // back there closes the viewer first, then this sheet, then leaves the chat.
  useBackHandler(true, onClose, { escape: true });

  // docs §5.4 — legacy fans don't batch-reveal on a single tap (each item is
  // an independent send, D4); this explicit "Reveal all" is the deliberate
  // opt-in for the whole pile instead. An album opened here (the "+N"
  // overflow tile) gets the same affordance for free.
  const blurredIds = blurredIdsOf(
    items.map((i) => i.media),
    isRevealed,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90 md:items-center md:justify-center"
      onClick={onClose}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        touchAction: 'manipulation',
      }}
    >
      {/* Full-bleed on a phone; a bounded centered panel on desktop, where
          filling a whole monitor with a handful of thumbnails "feels too
          much" (owner, 2026-08-12). `md:h-auto` lets the panel shrink to its
          content for small albums instead of always being 80vh tall. */}
      <div
        className="flex min-h-0 flex-1 flex-col md:h-auto md:max-h-[80vh] md:w-[min(90vw,880px)] md:flex-none md:overflow-hidden md:rounded-lg md:bg-neutral-900 md:shadow-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 text-white">
          <span className="text-sm font-semibold">{items.length} items</span>
          <div className="flex items-center gap-3">
            {blurredIds.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  reveal(blurredIds);
                }}
                className="flex items-center gap-1.5 rounded-pill bg-white/10 px-2.5 py-1 text-xs font-semibold"
                style={{ touchAction: 'manipulation' }}
              >
                <Eye size={13} />
                Reveal all ({blurredIds.length})
              </button>
            )}
            <button onClick={onClose} aria-label="Close" style={{ touchAction: 'manipulation' }}>
              <X size={22} />
            </button>
          </div>
        </div>
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-3 gap-1 overflow-y-auto p-1">
          {items.map((item, i) => (
            <GridTile key={item.media.id} media={item.media} thumbUrl={item.thumbUrl} onClick={() => onPick(i)} />
          ))}
        </div>
      </div>
    </div>
  );
}
