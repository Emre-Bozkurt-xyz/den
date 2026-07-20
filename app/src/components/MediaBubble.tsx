import { Loader2, Play, TriangleAlert, Video } from 'lucide-react';
import type { Message } from '@den/shared';

const LABEL: Record<'image' | 'video' | 'voice', string> = { image: 'photo', video: 'video', voice: 'voice message' };

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Renders a message's media (§7: image/video get a tap-to-expand bubble;
 *  voice is a first-class inline list item, never a thumbnail). Shows a
 *  'processing' placeholder until the media.ready WS frame lands. */
export function MediaBubble({ message, onOpen }: { message: Message; onOpen: () => void }) {
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
      <img
        src={media.thumbUrl ?? media.url ?? undefined}
        onClick={onOpen}
        alt=""
        className="max-h-64 max-w-full cursor-pointer rounded-md object-cover"
        style={{ touchAction: 'manipulation' }}
      />
    );
  }

  if (media.kind === 'video') {
    return (
      <div onClick={onOpen} className="relative cursor-pointer" style={{ touchAction: 'manipulation' }}>
        {media.thumbUrl ? (
          <img src={media.thumbUrl} alt="" className="max-h-64 max-w-full rounded-md object-cover" />
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

  // voice — inline player, not a thumbnail
  return (
    <div className="flex min-w-[220px] max-w-full items-center gap-2">
      {/* iOS requires a user gesture to start playback — native controls give us that for free. */}
      <audio controls preload="metadata" src={media.url ?? undefined} className="h-10 w-full" />
    </div>
  );
}
