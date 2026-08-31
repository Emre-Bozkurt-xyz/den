import { Loader2, Play, TriangleAlert, Video } from 'lucide-react';
import type { MediaInfo } from '@den/shared';
import { useIsBlurred, useSensitivity } from '../lib/sensitivity';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { PreviewImage } from './PreviewImage';
import { SensitiveOverlay } from './SensitiveOverlay';
import { VoiceMessage } from './VoiceMessage';

const LABEL: Record<'image' | 'video' | 'voice', string> = { image: 'photo', video: 'video', voice: 'voice message' };

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * The full-size "not ready yet" card — one implementation for every surface
 * that draws media at its natural size, so the reserved box and the wording
 * can't drift apart between them. Extracted from `MediaBubble` when the fanned
 * `MediaStack` turned out to need exactly the same thing (owner report,
 * 2026-08-31 — a still-transcoding video at the top of a fan drew an empty
 * frame, the same defect albums had). Tile-sized surfaces (an album's mosaic,
 * the grid sheet) deliberately do NOT share this: at ~95px square there is no
 * room for the full label, so they carry their own compact variant.
 *
 * `MediaStatus` is exactly `processing | ready | failed`, so a caller that has
 * ruled out `ready` has ruled in one of these two branches.
 */
export function MediaPlaceholder({ media }: { media: MediaInfo }) {
  if (media.status === 'failed') {
    return (
      <div className="flex h-24 w-48 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-2 text-center text-xs text-red-500">
        <TriangleAlert size={16} />
        {LABEL[media.kind]} failed to process
      </div>
    );
  }
  // docs/MEDIA_ATTACHMENTS.md §4.6 — reserve the real aspect when the sender
  // sent a size hint, so this card is already the shape the finished image
  // will be. The fixed `h-32` below is now only the fallback for rows with
  // no dimensions (voice, a file the sender's browser couldn't measure, or
  // anything uploaded before the hint existed). Without this the card grew
  // when processing finished, shoving the message list under whoever was
  // reading — the same class of bug `PreviewImage` fixes for loaded media
  // (PROJECT.md §14, 2026-07-22).
  const aspect = media.width && media.height ? `${media.width} / ${media.height}` : undefined;
  return (
    <div
      className={
        'flex w-48 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-surface-sunken text-xs text-text-muted ' +
        (aspect ? '' : 'h-32')
      }
      // Capped at the same max height a loaded image gets, so an extreme
      // portrait hint can't reserve a taller box than the real thing will.
      style={aspect ? { aspectRatio: aspect, maxHeight: '18rem' } : undefined}
    >
      <Loader2 size={18} className="animate-spin" />
      Processing {LABEL[media.kind]}…
    </div>
  );
}

/** Renders one media item (§7). As of UI-7 photos/videos are drawn *bare* —
 *  no bubble behind them, Instagram-style — so the rounding here is the
 *  visible edge of the message, not an inset thumbnail. Voice stays a
 *  first-class inline row (never a thumbnail) and is the one kind that does
 *  still live inside a bubble, so it draws in `currentColor` to inherit
 *  whichever bubble it landed in. Shows a 'processing' placeholder until the
 *  media.ready WS frame lands.
 *
 *  Takes `media: MediaInfo` directly (not `Message`) as of
 *  docs/MEDIA_ATTACHMENTS.md §5.3/§5.7 — `AlbumCard`'s mosaic tiles need to
 *  render individual items that don't each have their own `Message`, and a
 *  captioned single-media message now hands this just the one item it wants
 *  drawn inside its own container.
 *
 *  Sensitive media (docs §5.4/§5.8) is wrapped in the one shared
 *  `SensitiveOverlay` — blur state comes from `useIsBlurred`, driven by
 *  `media.sensitivity`, never re-derived from tag names here. */
export function MediaBubble({
  media,
  onOpen,
  interactive = true,
  className = '',
  rounded = true,
}: {
  media: MediaInfo;
  onOpen: () => void;
  /** False while multi-select is active — taps belong to selection, so inner
   *  controls (voice play/seek) go inert instead of competing for them. */
  interactive?: boolean;
  /** Extra classes for the `SensitiveOverlay` wrapper — lets `AlbumCard`
   *  pass tile-specific sizing (square, object-cover) without this component
   *  needing to know about mosaic layout. */
  className?: string;
  /** False inside a captioned-media container (docs/MEDIA_ATTACHMENTS.md
   *  §5.3): "the image loses its own radius — the container clips it" is
   *  what makes the merged card read as one object instead of a rounded
   *  photo awkwardly inset inside another rounded card. Bare (uncaptioned)
   *  media keeps its own `rounded-md`, unchanged. */
  rounded?: boolean;
}) {
  const { reveal } = useSensitivity();
  const blurred = useIsBlurred(media);

  if (media.status !== 'ready') return <MediaPlaceholder media={media} />;

  if (media.kind === 'image') {
    return (
      <SensitiveOverlay
        sensitivity={media.sensitivity}
        blurred={blurred}
        onReveal={() => reveal(media.id)}
        className={(rounded ? 'rounded-md ' : '') + className}
      >
        <PreviewImage
          media={media}
          src={media.thumbUrl ?? media.url ?? undefined}
          onClick={onOpen}
          onContextMenu={suppressTouchContextMenu}
          alt=""
          className={'media-preview max-h-72 max-w-full cursor-pointer object-cover ' + (rounded ? 'rounded-md' : '')}
          style={{ touchAction: 'manipulation' }}
        />
      </SensitiveOverlay>
    );
  }

  if (media.kind === 'video') {
    return (
      <SensitiveOverlay
        sensitivity={media.sensitivity}
        blurred={blurred}
        onReveal={() => reveal(media.id)}
        className={(rounded ? 'rounded-md ' : '') + className}
      >
        <div
          onClick={onOpen}
          onContextMenu={suppressTouchContextMenu}
          className="media-preview relative cursor-pointer"
          style={{ touchAction: 'manipulation' }}
        >
          {media.thumbUrl ? (
            <PreviewImage
              media={media}
              src={media.thumbUrl}
              alt=""
              className={'max-h-72 max-w-full object-cover ' + (rounded ? 'rounded-md' : '')}
            />
          ) : (
            <div className="flex h-32 w-48 flex-col items-center justify-center gap-1.5 rounded-md bg-surface-sunken text-xs text-text-secondary">
              <Video size={18} />
              Video
            </div>
          )}
          <span className="absolute inset-0 grid place-items-center">
            <span className="grid h-10 w-10 place-items-center rounded-pill bg-black/50 text-white">
              <Play size={18} fill="currentColor" />
            </span>
          </span>
          {media.durationMs != null && (
            <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
              {formatDuration(media.durationMs)}
            </span>
          )}
        </div>
      </SensitiveOverlay>
    );
  }

  // voice — custom inline player (UI-7), not native <audio controls>. Never
  // staged, never blurred (docs §6): sensitivity toggles don't exist for it.
  return <VoiceMessage media={media} interactive={interactive} />;
}
