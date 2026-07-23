import { Loader2, Play, TriangleAlert, Video } from 'lucide-react';
import type { Message } from '@den/shared';
import { suppressTouchContextMenu } from '../lib/nativeMenu';
import { PreviewImage } from './PreviewImage';
import { VoiceMessage } from './VoiceMessage';

const LABEL: Record<'image' | 'video' | 'voice', string> = { image: 'photo', video: 'video', voice: 'voice message' };

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Renders a message's media (§7). As of UI-7 photos/videos are drawn *bare*
 *  — no bubble behind them, Instagram-style — so the rounding here is the
 *  visible edge of the message, not an inset thumbnail. `ChatView` is what
 *  decides not to wrap them; this component just never assumes a background.
 *  Voice stays a first-class inline row (never a thumbnail) and is the one
 *  kind that does still live inside a bubble, so it draws in `currentColor`
 *  to inherit whichever bubble it landed in. Shows a 'processing'
 *  placeholder until the media.ready WS frame lands. */
export function MediaBubble({
  message,
  onOpen,
  interactive = true,
}: {
  message: Message;
  onOpen: () => void;
  /** False while multi-select is active — taps belong to selection, so inner
   *  controls (voice play/seek) go inert instead of competing for them. */
  interactive?: boolean;
}) {
  const media = message.media;
  if (!media) return null;

  if (media.status === 'processing') {
    return (
      <div className="flex h-32 w-48 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-surface-sunken text-xs text-text-muted">
        <Loader2 size={18} className="animate-spin" />
        Processing {LABEL[media.kind]}…
      </div>
    );
  }

  if (media.status === 'failed') {
    return (
      <div className="flex h-24 w-48 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-red-500/20 bg-red-500/10 px-2 text-center text-xs text-red-500">
        <TriangleAlert size={16} />
        {LABEL[media.kind]} failed to process
      </div>
    );
  }

  if (media.kind === 'image') {
    return (
      <PreviewImage
        media={media}
        src={media.thumbUrl ?? media.url ?? undefined}
        onClick={onOpen}
        onContextMenu={suppressTouchContextMenu}
        alt=""
        className="media-preview max-h-72 max-w-full cursor-pointer rounded-md object-cover"
        style={{ touchAction: 'manipulation' }}
      />
    );
  }

  if (media.kind === 'video') {
    return (
      <div
        onClick={onOpen}
        onContextMenu={suppressTouchContextMenu}
        className="media-preview relative cursor-pointer"
        style={{ touchAction: 'manipulation' }}
      >
        {media.thumbUrl ? (
          <PreviewImage media={media} src={media.thumbUrl} alt="" className="max-h-72 max-w-full rounded-md object-cover" />
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
    );
  }

  // voice — custom inline player (UI-7), not native <audio controls>
  return <VoiceMessage media={media} interactive={interactive} />;
}
