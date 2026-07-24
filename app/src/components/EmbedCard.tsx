import { Clapperboard, ExternalLink, Link as LinkIcon, Loader2, TriangleAlert } from 'lucide-react';
import type { EmbedProvider, Message } from '@den/shared';
import { suppressTouchContextMenu } from '../lib/nativeMenu';

/**
 * The ONE shared card renderer for every embed provider (docs/EMBEDS.md
 * §4.4) — Instagram today, Vault (Phase 3/4) later, with zero new client
 * code beyond a badge/icon lookup here. Mirrors `MediaBubble`'s posture:
 * bubble-less, self-contained, `status`-gated (skeleton while processing,
 * link fallback on failure).
 *
 * The thumbnail box is a fixed `aspect-[9/16]` (portrait reels,
 * docs/EMBEDS.md §4.5) rather than measured from stored dimensions like
 * `PreviewImage` — embeds have no width/height column (§4.1's schema), so a
 * fixed aspect is the only way to reserve layout before the image decodes
 * and avoid the chat's scroll-to-bottom regressing (the same class of bug
 * PreviewImage fixes for media, PROJECT.md §14 2026-07-22).
 */

const PROVIDER_LABEL: Record<EmbedProvider, string> = { instagram: 'Instagram', vault: 'Vault' };

// lucide-react dropped brand/logo icons (no `Instagram` glyph in this
// version) — `Clapperboard` stands in as a generic "video reel" glyph
// instead of a brand mark, which is arguably the more honest choice anyway
// (Den isn't licensed to use Instagram's logo).
function ProviderIcon({ provider, size }: { provider: EmbedProvider; size: number }) {
  if (provider === 'instagram') return <Clapperboard size={size} />;
  return <LinkIcon size={size} />;
}

export function EmbedCard({
  message,
  onOpen,
  interactive = true,
}: {
  message: Message;
  onOpen: () => void;
  /** False while multi-select is active — matches `MediaBubble`'s prop, kept
   *  even though nothing inside this card is interactive yet (no play/seek
   *  control the way voice has) so the two stay call-compatible. */
  interactive?: boolean;
}) {
  const embed = message.embed;
  if (!embed) return null;

  if (embed.status === 'processing') {
    return (
      <div className="flex aspect-[9/16] w-48 max-w-full flex-col items-center justify-center gap-1.5 rounded-md border border-border bg-surface-sunken text-xs text-text-muted">
        <Loader2 size={18} className="animate-spin" />
        Loading {PROVIDER_LABEL[embed.provider]} card…
      </div>
    );
  }

  // Failure fallback (docs/EMBEDS.md §4.3): a plain clickable link, never a
  // broken half-rendered card. Also covers the degenerate 'ready' case where
  // the resolver found nothing worth showing (shouldn't happen — the
  // Instagram resolver treats that as a failure itself — but a link is
  // always a safe floor for any future provider that might).
  const hasContent = embed.thumbUrl || embed.title || embed.description;
  if (embed.status === 'failed' || !hasContent) {
    return (
      <a
        href={embed.canonicalUrl ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (!interactive || !embed.canonicalUrl) e.preventDefault();
        }}
        className="media-preview flex w-64 max-w-full items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-sm text-accent"
        style={{ touchAction: 'manipulation' }}
      >
        {embed.status === 'failed' ? <TriangleAlert size={15} className="shrink-0 text-text-muted" /> : <LinkIcon size={15} className="shrink-0" />}
        <span className="truncate underline decoration-accent/40 underline-offset-2">
          {embed.canonicalUrl ?? `${PROVIDER_LABEL[embed.provider]} link unavailable`}
        </span>
      </a>
    );
  }

  return (
    <div
      onClick={onOpen}
      onContextMenu={suppressTouchContextMenu}
      className="media-preview relative w-48 max-w-full cursor-pointer overflow-hidden rounded-md border border-border bg-surface-sunken"
      style={{ touchAction: 'manipulation' }}
    >
      <div className="relative aspect-[9/16] w-full bg-surface-sunken">
        {embed.thumbUrl ? (
          <img src={embed.thumbUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full place-items-center text-text-muted">
            <ProviderIcon provider={embed.provider} size={28} />
          </div>
        )}
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1 rounded-pill bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
          <ProviderIcon provider={embed.provider} size={11} />
          {PROVIDER_LABEL[embed.provider]}
        </span>
        {embed.actionType === 'external' && (
          <span className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-pill bg-black/50 text-white">
            <ExternalLink size={12} />
          </span>
        )}
      </div>
      {(embed.title || embed.subtitle) && (
        <div className="flex flex-col gap-0.5 px-2.5 py-2">
          {embed.subtitle && <p className="truncate text-xs font-semibold text-text-primary">{embed.subtitle}</p>}
          {embed.title && <p className="line-clamp-2 text-xs text-text-secondary">{embed.title}</p>}
        </div>
      )}
    </div>
  );
}
