import type { Message } from '@den/shared';
import { formatDateLabel, formatTime, isSameCalendarDay, isToday } from './datetime';

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

function firstMessageOf(run: MessageRun): Message | null {
  const block = run.blocks[0];
  if (!block) return null;
  return block.kind === 'single' ? block.message : (block.messages[0] ?? null);
}

/** Every message a block covers — one for a single, all of them for a stack.
 *  Used by selection (long-pressing a stack selects the whole stack). */
export function blockMessages(block: MessageBlock): Message[] {
  return block.kind === 'single' ? [block.message] : block.messages;
}

// ─── UI-8b — date/time dividers (request D, docs/UI8_CHAT_INSTAGRAM.md) ────

/** Same-day gap (ms) big enough to earn its own time divider even without a
 *  calendar-day change — Instagram's "quiet afternoon" break. */
export const DIVIDER_GAP_MS = 60 * 60 * 1000; // 1 hour

export type TimelineItem =
  | { kind: 'divider'; id: string; label: string }
  | { kind: 'run'; run: MessageRun };

/**
 * Interleaves date/time dividers between runs for rendering. Purely derived
 * — nothing is stored, so paginating in an older page ("Load older
 * messages") just recomputes this over whatever's currently loaded; there's
 * no cached divider set to invalidate.
 *
 * A divider is inserted before a run when either:
 *  - its first message's calendar day differs from the previous run's last
 *    message (or there *is* no previous run — the very first run in the
 *    loaded list always gets a divider), or
 *  - it's the same calendar day but the gap since the previous run's last
 *    message exceeds `DIVIDER_GAP_MS`.
 *
 * The label itself is a *date* ("Yesterday" / a weekday / "MMM D") when the
 * boundary's day isn't today, and a *time* ("4:23 PM") when it is — matching
 * Instagram, which never prints a literal "Today" header, whether that's the
 * very top of an all-today chat or a same-day gap. A same-calendar-day gap
 * divider (the second bullet above) is always a time, regardless of which
 * day it falls on — see `lib/datetime.ts`.
 */
export function buildTimeline(runs: MessageRun[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  let prevLast: Message | null = null;

  for (const run of runs) {
    const first = firstMessageOf(run);
    if (first) {
      const dayChanged = !prevLast || !isSameCalendarDay(prevLast.createdAt, first.createdAt);
      const gapMs = prevLast ? Date.parse(first.createdAt) - Date.parse(prevLast.createdAt) : 0;
      if (dayChanged || gapMs > DIVIDER_GAP_MS) {
        const label = isToday(first.createdAt)
          ? formatTime(first.createdAt)
          : dayChanged
            ? formatDateLabel(first.createdAt)
            : formatTime(first.createdAt);
        out.push({ kind: 'divider', id: `divider:${first.id}`, label });
      }
    }
    out.push({ kind: 'run', run });
    prevLast = lastMessageOf(run);
  }

  return out;
}
