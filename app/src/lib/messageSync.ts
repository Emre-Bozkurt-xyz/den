import type { InfiniteData } from '@tanstack/react-query';
import type { Message, MessagesResponse } from '@den/shared';

/** Same shape `realtime.tsx` patches — kept here rather than imported from it
 *  so this module stays dependency-free and testable without a DOM. */
export type MessagesCache = InfiniteData<MessagesResponse, string | null>;

/** Local (never-reached-the-server) bubbles. Duplicated from `realtime.tsx`'s
 *  `isLocalId` on purpose: this module is imported *by* realtime, and a cycle
 *  between them would be worse than one two-line predicate. Both sides read
 *  the same two prefixes, which are a protocol constant (docs/RECEIPTS.md
 *  §5.3), not a private detail of either file. */
function isLocalId(id: string): boolean {
  return id.startsWith('pending:') || id.startsWith('failed:');
}

/**
 * Merge a freshly-fetched *newest* page (`?before=` unset) into an existing
 * infinite-query cache — the catch-up half of `resyncChat` in `realtime.tsx`.
 *
 * Why this exists at all: `invalidateQueries(['messages'])` on an infinite
 * query refetches **every loaded page, sequentially**. After a long scroll
 * back through history that is N round-trips on a just-woken mobile radio
 * before a single new message can render, which is what "the chat sat there
 * not updating until I backed out and came in again" was (owner report,
 * 2026-08-23). Catching up is a bounded, single-request problem, so it gets a
 * bounded, single-request answer.
 *
 * The rules, in the order they matter:
 *
 * 1. **The server page is authoritative over the range it covers.** Its
 *    oldest id is a floor: any cached message at or above that floor that the
 *    page did *not* return no longer exists (`getMessagesPage` filters
 *    `deleted_at IS NULL`, so a delete is an omission, never a tombstone) and
 *    is dropped. Cached messages below the floor are untouched — the page
 *    says nothing about them.
 * 2. **No overlap means a gap.** If the page shares no id with anything
 *    cached, more than one page's worth of history landed while we were away
 *    and merging would leave a hole in the middle of the list. The cache is
 *    reset to exactly this page instead; scrolling up re-paginates normally.
 *    Server is truth (hard invariant 3) — never stitch across an unknown gap.
 * 3. **Local bubbles survive both paths.** A pending or failed send is not
 *    something the server can return, and dropping it would silently discard
 *    the user's unsent message.
 */
export function mergeNewestPage(cache: MessagesCache | undefined, page: MessagesResponse): MessagesCache {
  const locals = cache?.pages[0]?.messages.filter((m) => isLocalId(m.id)) ?? [];
  const fresh = (): MessagesCache => ({
    pages: [{ ...page, messages: [...locals, ...page.messages] }],
    pageParams: [null],
  });

  if (!cache || cache.pages.length === 0) return fresh();

  const cachedReal = new Set<string>();
  for (const p of cache.pages) for (const m of p.messages) if (!isLocalId(m.id)) cachedReal.add(m.id);

  // Rule 2 — an empty page also lands here when the chat still has messages
  // cached: the server says there are none, so the cache must say none too.
  const overlaps = page.messages.some((m) => cachedReal.has(m.id));
  if (cachedReal.size > 0 && !overlaps) return fresh();

  const byId = new Map(page.messages.map((m) => [m.id, m]));
  const floor = page.messages.length > 0 ? BigInt(page.messages[page.messages.length - 1]!.id) : null;

  // Rule 1 — prune, then patch, in one pass per page. `floor === null` can
  // only be reached when the cache held nothing real either (otherwise rule 2
  // returned above), so the predicate's `false` branch is unreachable then.
  const pages = cache.pages.map((p) => ({
    ...p,
    messages: p.messages.flatMap((m) => {
      if (isLocalId(m.id)) return [m];
      const server = byId.get(m.id);
      if (server) return [server];
      return floor !== null && BigInt(m.id) < floor ? [m] : [];
    }),
  }));

  // Whatever the page brought that we'd never seen — by definition newer than
  // anything cached, so it belongs at the top of page 0 (newest-first).
  const added = page.messages.filter((m) => !cachedReal.has(m.id));
  if (added.length > 0) {
    const first = pages[0]!;
    pages[0] = { ...first, messages: [...first.messages, ...added].sort(byIdDesc) };
  }
  return { ...cache, pages };
}

/** Newest-first by numeric id, with local bubbles pinned above everything —
 *  the same order `realtime.tsx` restores deleted messages into, and the
 *  order every page arrives in from the server. */
function byIdDesc(a: Message, b: Message): number {
  const aLocal = isLocalId(a.id);
  const bLocal = isLocalId(b.id);
  if (aLocal || bLocal) return aLocal && bLocal ? 0 : aLocal ? -1 : 1;
  const an = BigInt(a.id);
  const bn = BigInt(b.id);
  return an === bn ? 0 : an > bn ? -1 : 1;
}
