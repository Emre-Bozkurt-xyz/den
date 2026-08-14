import { MoreVertical, Reply, Smile, Star } from 'lucide-react';

/**
 * Desktop-only hover action bar next to a bubble (UI-8c request G,
 * docs/archive/UI8_CHAT_INSTAGRAM.md) — replaces the old lone `MoreVertical` hover
 * button with a small three-icon row: More / Reply / React, matching the
 * reference screenshots. `ChatView` positions one of these outside each
 * side of the bubble (`mine` → left of it, others → right of it) exactly
 * where the old single button sat, so it's opacity-0→100 on
 * `group-hover`/`group-focus-within` like every other hover affordance in
 * this file's family.
 *
 * Reply and React are both real (post-MVP): `onReply` sets `ChatView`'s
 * `replyingTo`. `onReact` opens the same focus menu `onMore` does — the
 * focus menu now carries the quick-emoji row, so there's no separate
 * reaction picker to build here; both buttons just open it.
 */
export function MessageActions({
  onMore,
  onReply,
  onReact,
  onFavorite,
  favorited,
  onlyMore,
}: {
  onMore: () => void;
  onReply: () => void;
  onReact: () => void;
  /** docs/GIF_FAVORITES.md §8.1 / D-F5 — present only for an inline GIF, which
   *  is the only message kind with anything to save. A star *overlaid* on the
   *  GIF's corner was considered and rejected: it would appear on hover at the
   *  same instant as this bar, giving one bubble two competing affordances.
   *  Undefined for every other message, and then no star renders. */
  onFavorite?: () => void;
  favorited?: boolean;
  /** docs/RECEIPTS.md §5.4 — a failed send has no reply target and nothing
   *  to react to (it never reached the server); only the "More" icon (→ the
   *  Discard-only focus menu) applies. */
  onlyMore?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <IconButton icon={MoreVertical} label="Message actions" onClick={onMore} />
      {!onlyMore && (
        <>
          <IconButton icon={Reply} label="Reply" onClick={onReply} />
          <IconButton icon={Smile} label="React" onClick={onReact} />
          {onFavorite && (
            <IconButton
              icon={Star}
              label={favorited ? 'Remove from favorites' : 'Save to favorites'}
              onClick={onFavorite}
              filled={favorited}
            />
          )}
        </>
      )}
    </div>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  filled,
}: {
  icon: typeof MoreVertical;
  label: string;
  onClick: () => void;
  /** Renders the glyph solid rather than outlined — the star's "on" state. */
  filled?: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      aria-pressed={filled}
      className={
        'rounded-pill p-1 transition-colors hover:bg-surface-sunken ' + (filled ? 'text-accent' : 'text-text-muted')
      }
      style={{ touchAction: 'manipulation' }}
    >
      <Icon size={14} className={filled ? 'fill-current' : undefined} />
    </button>
  );
}
