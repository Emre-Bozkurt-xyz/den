import { useEffect, useRef, useState } from 'react';
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
 * Reply is real (post-MVP): `onReply` sets `ChatView`'s `replyingTo`.
 *
 * **React is still an inert placeholder** — wired up alongside the rest of
 * the reactions feature (quick-emoji row, reaction pills) in a later change,
 * so this button doesn't jump ahead of the reply-only stage it ships with.
 */
export function MessageActions({ onMore, onReply }: { onMore: () => void; onReply: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
      <IconButton icon={MoreVertical} label="Message actions" onClick={onMore} />
      <IconButton icon={Reply} label="Reply" onClick={onReply} />
      <PlaceholderIconButton icon={Smile} label="React" />
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

const TOOLTIP_MS = 1400;

/** Reply/React button: a real, focusable, labeled control (so it doesn't
 *  read as broken/missing to a11y tooling or a curious click) that does
 *  nothing to app state — a transient "Coming soon" tooltip is the entire
 *  observable effect. */
function PlaceholderIconButton({ icon: Icon, label }: { icon: typeof Reply; label: string }) {
  const [shown, setShown] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <span className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setShown(true);
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setShown(false), TOOLTIP_MS);
        }}
        aria-label={`${label} (coming soon)`}
        title={`${label} (coming soon)`}
        className="rounded-pill p-1 text-text-muted transition-colors hover:bg-surface-sunken"
        style={{ touchAction: 'manipulation' }}
      >
        <Icon size={14} />
      </button>
      {shown && (
        <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-surface-raised px-2 py-1 text-[11px] text-text-secondary shadow-strong">
          Coming soon
        </span>
      )}
    </span>
  );
}
