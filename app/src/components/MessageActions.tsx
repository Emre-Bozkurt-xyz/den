import { MoreVertical, Reply, Smile } from 'lucide-react';

/**
 * Desktop-only hover action bar next to a bubble (UI-8c request G,
 * docs/UI8_CHAT_INSTAGRAM.md) — replaces the old lone `MoreVertical` hover
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
}: {
  onMore: () => void;
  onReply: () => void;
  onReact: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <IconButton icon={MoreVertical} label="Message actions" onClick={onMore} />
      <IconButton icon={Reply} label="Reply" onClick={onReply} />
      <IconButton icon={Smile} label="React" onClick={onReact} />
    </div>
  );
}

function IconButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof MoreVertical;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className="rounded-pill p-1 text-text-muted transition-colors hover:bg-surface-sunken"
      style={{ touchAction: 'manipulation' }}
    >
      <Icon size={14} />
    </button>
  );
}
