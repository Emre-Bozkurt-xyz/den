import type { Message } from '@den/shared';

/**
 * Presentation-only grouping of a chat's flat message list (docs/UI_REVAMP.md
 * UI-7). Nothing here touches the wire format: the server still stores and
 * sends one message per media item — a "stack" is purely how several of them
 * are drawn.
 *
 * Two levels:
 *  - **Runs** — consecutive messages from the same sender within
 *    `RUN_WINDOW_MS`. A run is drawn as one tight column; only its *last*
 *    bubble gets the tail corner, and a group chat's sender label is printed
 *    once at the top instead of on every bubble.
 *  - **Blocks** — inside a run, adjacent bare image/video messages collapse
 *    into a fanned stack; everything else stays a single bubble.
 */

/** Same-sender messages closer together than this share a run. 5 minutes is
 *  the usual messenger convention — long enough that a back-and-forth reads
 *  as one turn, short enough that "later that evening" starts a new one. */
export const RUN_WINDOW_MS = 5 * 60 * 1000;

export type MessageBlock =
  | { kind: 'single'; message: Message }
  | { kind: 'stack'; messages: Message[] };

export interface MessageRun {
  /** Stable across renders: the first message's id (ids are server-assigned
   *  and immutable; an optimistic `pending:` id is replaced by a remount when
   *  the real message arrives, which is the behavior we want anyway). */
  key: string;
  senderId: string;
  blocks: MessageBlock[];
}

/** Only *bare* ready photos/videos fan out. A caption makes the item a
 *  standalone thought (it needs its own text bubble beneath it), and a
 *  still-processing or failed item has no thumbnail to draw as a card.
 *  `pending:` uploads are excluded so an in-flight item can't be swept into
 *  a stack whose long-press would then try to select an id that doesn't
 *  exist server-side yet. */
export function isStackable(m: Message): boolean {
  return (
    !m.body &&
    !m.id.startsWith('pending:') &&
    m.media?.status === 'ready' &&
    (m.media.kind === 'image' || m.media.kind === 'video')
  );
}

/** @param stack — false while multi-select is active: selection and deletion
 *  are per-message operations, so the stack expands back into individually
 *  tappable bubbles rather than presenting N messages as one target. */
export function groupMessages(messages: Message[], { stack }: { stack: boolean }): MessageRun[] {
  const runs: MessageRun[] = [];

  for (const m of messages) {
    const current = runs[runs.length - 1];
    const prev = current ? lastMessageOf(current) : null;
    const continues =
      current !== undefined &&
      prev !== null &&
      current.senderId === m.senderId &&
      Date.parse(m.createdAt) - Date.parse(prev.createdAt) <= RUN_WINDOW_MS;

    if (!continues) {
      runs.push({ key: m.id, senderId: m.senderId, blocks: [{ kind: 'single', message: m }] });
      continue;
    }

    const blocks = current.blocks;
    const tail = blocks[blocks.length - 1]!;
    if (!stack || !isStackable(m)) {
      blocks.push({ kind: 'single', message: m });
    } else if (tail.kind === 'stack') {
      tail.messages.push(m);
    } else if (isStackable(tail.message)) {
      blocks[blocks.length - 1] = { kind: 'stack', messages: [tail.message, m] };
    } else {
      blocks.push({ kind: 'single', message: m });
    }
  }

  return runs;
}

function lastMessageOf(run: MessageRun): Message | null {
  const block = run.blocks[run.blocks.length - 1];
  if (!block) return null;
  return block.kind === 'single' ? block.message : (block.messages[block.messages.length - 1] ?? null);
}

/** Every message a block covers — one for a single, all of them for a stack.
 *  Used by selection (long-pressing a stack selects the whole stack). */
export function blockMessages(block: MessageBlock): Message[] {
  return block.kind === 'single' ? [block.message] : block.messages;
}
