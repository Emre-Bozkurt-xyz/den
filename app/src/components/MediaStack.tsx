import { Layers, Play, X } from 'lucide-react';
import type { Message } from '@den/shared';
import { useBackHandler } from '../lib/backStack';

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
 */

/** Rotation/offset of the cards *behind* the top one, back to front. Kept
 *  deliberately small — this is a hint of depth, not a fan of playing cards.
 *  Only two are ever drawn no matter how large the stack; the badge carries
 *  the real count. */
const BACK_CARDS = [
  { rotate: -5, x: -6, y: 5 },
  { rotate: 3.5, x: 5, y: 3 },
] as const;

function thumbOf(m: Message): string | undefined {
  return m.media?.thumbUrl ?? m.media?.url ?? undefined;
}

export function MediaStack({ messages, onOpen }: { messages: Message[]; onOpen: () => void }) {
  const [top, ...rest] = messages;
  if (!top) return null;
  // Back cards are drawn from the *end* of the stack so the card immediately
  // behind the top one is the next item, not the last.
  const backs = rest.slice(0, BACK_CARDS.length);

  return (
    <div className="relative w-fit cursor-pointer" onClick={onOpen} style={{ touchAction: 'manipulation' }}>
      {backs.map((m, i) => (
        <img
          key={m.id}
          src={thumbOf(m)}
          alt=""
          aria-hidden
          // inset-0 resolves against the box the in-flow top card establishes
          // below, so the pile always matches the top card's dimensions.
          className="absolute inset-0 h-full w-full rounded-md object-cover shadow-soft"
          style={{
            transform: `translate(${BACK_CARDS[i]!.x}px, ${BACK_CARDS[i]!.y}px) rotate(${BACK_CARDS[i]!.rotate}deg)`,
            zIndex: 0,
          }}
        />
      ))}
      <img src={thumbOf(top)} alt="" className="relative z-10 max-h-72 max-w-full rounded-md object-cover" />
      <span className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-pill bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
        <Layers size={12} />
        {messages.length}
      </span>
    </div>
  );
}

/** Grid sheet listing every item in a tapped stack. Deliberately a plain
 *  square grid (not the gallery's masonry) — this is a handful of items from
 *  one moment, and uniform tiles make "which one do I want" the only
 *  question on screen. */
export function MediaGridSheet({
  messages,
  onPick,
  onClose,
}: {
  messages: Message[];
  onPick: (index: number) => void;
  onClose: () => void;
}) {
  // System back gesture / browser back closes the sheet (matches the X and the
  // backdrop tap), instead of unwinding the chat → chat list. Opening the
  // viewer from a tile registers the viewer's own handler on top (LIFO), so
  // back there closes the viewer first, then this sheet, then leaves the chat.
  useBackHandler(true, onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/90"
      onClick={onClose}
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        touchAction: 'manipulation',
      }}
    >
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <span className="text-sm font-semibold">{messages.length} items</span>
        <button onClick={onClose} aria-label="Close" style={{ touchAction: 'manipulation' }}>
          <X size={22} />
        </button>
      </div>
      <div
        className="grid flex-1 auto-rows-min grid-cols-3 gap-1 overflow-y-auto p-1"
        onClick={(e) => e.stopPropagation()}
      >
        {messages.map((m, i) => (
          <button
            key={m.id}
            onClick={() => onPick(i)}
            className="relative aspect-square overflow-hidden rounded-sm bg-white/5"
            style={{ touchAction: 'manipulation' }}
          >
            <img src={thumbOf(m)} alt="" className="h-full w-full object-cover" />
            {m.media?.kind === 'video' && (
              <span className="absolute inset-0 grid place-items-center">
                <span className="grid h-9 w-9 place-items-center rounded-pill bg-black/50 text-white">
                  <Play size={16} fill="currentColor" />
                </span>
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
