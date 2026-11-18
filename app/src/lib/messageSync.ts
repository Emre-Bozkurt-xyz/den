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

/** The send's reqId behind a local bubble id (`pending:<reqId>` /
 *  `failed:<reqId>`), or null for a real id. The reqId doubles as the
 *  message's server-side idempotency key (shared `Message.clientNonce`), which
 *  is what lets a fetched row be recognised as "this bubble, delivered". */
export function localReqId(id: string): string | null {
  if (id.startsWith('pending:')) return id.slice('pending:'.length);
  if (id.startsWith('failed:')) return id.slice('failed:'.length);
  return null;
}

function cursorValue(cursor: string | null | undefined): bigint | null {
  if (typeof cursor !== 'string') return null;
  try {
    return BigInt(cursor);
  } catch {
    return null;
  }
}

/**
 * The slice of id-space page `i` owns: `[lo, hi)`, null = unbounded.
 *
 * Keyset pagination makes this exact: page `i` was fetched as "ids below
 * `pageParams[i]`" and handed its `nextCursor` (its oldest id) on as the next
 * page's bound, so the cursors partition the id line with no overlap. Every
 * insert below goes through this, so a message can only ever live on the one
 * page whose range covers it — the alternative (always prepending to page 0)
 * is how a restored or caught-up old message ended up sorted below page 1's
 * top, or duplicated when page 1 was later fetched over it.
 */
function pageBounds(cache: MessagesCache, i: number): { lo: bigint | null; hi: bigint | null } {
  return {
    lo: cursorValue(cache.pages[i]?.nextCursor),
    hi: i === 0 ? null : cursorValue(cache.pageParams[i]),
  };
}

function inBounds(id: bigint, { lo, hi }: { lo: bigint | null; hi: bigint | null }): boolean {
  return (lo === null || id >= lo) && (hi === null || id < hi);
}

/**
 * Put server messages into the cache, each on the page that owns its id
 * (`pageBounds`). A message already cached anywhere is replaced in place
 * rather than inserted again; one older than everything loaded is dropped —
 * paginating there fetches it, and caching it now would duplicate it then.
 */
export function insertMessages(cache: MessagesCache | undefined, incoming: Message[]): MessagesCache | undefined {
  if (!cache || cache.pages.length === 0 || incoming.length === 0) return cache;
  const byId = new Map(incoming.map((m) => [m.id, m]));
  const pages = cache.pages.map((p) => ({
    ...p,
    messages: p.messages.map((m) => {
      const fresh = byId.get(m.id);
      if (!fresh) return m;
      byId.delete(m.id);
      return fresh;
    }),
  }));
  const touched = new Set<number>();
  for (const m of byId.values()) {
    const id = cursorValue(m.id);
    if (id === null) continue;
    const i = pages.findIndex((_, idx) => inBounds(id, pageBounds(cache, idx)));
    if (i === -1) continue;
    pages[i] = { ...pages[i]!, messages: [...pages[i]!.messages, m] };
    touched.add(i);
  }
  for (const i of touched) pages[i] = { ...pages[i]!, messages: pages[i]!.messages.slice().sort(byIdDesc) };
  return { ...cache, pages };
}

/**
 * Apply a `message.new` (a live broadcast, or the ack of our own send —
 * `reqId` set). The local bubble for `reqId` is replaced by the real message
 * in place; if the real message is already cached (a catch-up merge or an
 * earlier frame got there first), the bubble is just removed. Never inserts a
 * second copy of an id. A message with no bubble and no cached copy goes on
 * top of page 0 — it is by definition the newest thing in the chat.
 */
export function applyServerMessage(
  cache: MessagesCache | undefined,
  message: Message,
  reqId?: string,
): MessagesCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  const exists = cache.pages.some((p) => p.messages.some((m) => m.id === message.id));
  let placed = exists;
  const pages = cache.pages.map((p) => ({
    ...p,
    messages: p.messages.flatMap((m) => {
      if (m.id === message.id) return [message];
      if (reqId !== undefined && isLocalId(m.id) && localReqId(m.id) === reqId) {
        if (placed) return [];
        placed = true;
        return [message];
      }
      return [m];
    }),
  }));
  if (!placed) pages[0] = { ...pages[0]!, messages: [message, ...pages[0]!.messages] };
  return { ...cache, pages };
}

/** reqIds a fetched page proves were delivered — the sender's own rows carry
 *  their nonce (shared `Message.clientNonce`; never set on anyone else's). */
export function deliveredReqIds(page: MessagesResponse): Set<string> {
  const out = new Set<string>();
  for (const m of page.messages) if (m.clientNonce) out.add(m.clientNonce);
  return out;
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
 * 3. **Local bubbles survive both paths** — unless the page proves they were
 *    delivered. A pending or failed send the server never got must stay, or
 *    the user's unsent message silently vanishes. But one whose frame DID
 *    land and whose ack was lost comes back on this page as a real row
 *    carrying the bubble's reqId as `clientNonce` (own messages only); that
 *    bubble is dropped so the message shows once, not twice with a Retry
 *    button on the copy (PROJECT.md §14, 2026-11-18).
 * 4. **New rows go on the page that owns their id** (`insertMessages`), never
 *    blindly onto page 0, and are never inserted twice.
 */
export function mergeNewestPage(cache: MessagesCache | undefined, page: MessagesResponse): MessagesCache {
  const delivered = deliveredReqIds(page);
  const undelivered = (m: Message): boolean => !delivered.has(localReqId(m.id) ?? '');
  const locals = cache?.pages[0]?.messages.filter((m) => isLocalId(m.id) && undelivered(m)) ?? [];
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
      if (isLocalId(m.id)) return undelivered(m) ? [m] : [];
      const server = byId.get(m.id);
      if (server) return [server];
      return floor !== null && BigInt(m.id) < floor ? [m] : [];
    }),
  }));

  // Whatever the page brought that we'd never seen — almost always newer than
  // anything cached (so page 0), but a row restored while we were away can
  // belong further down; `insertMessages` routes each to its own page.
  const added = page.messages.filter((m) => !cachedReal.has(m.id));
  return insertMessages({ ...cache, pages }, added) ?? { ...cache, pages };
}

/**
 * Re-validate one DEEPER page (index ≥ 1) of an open chat after a resume —
 * `fetched` is `GET ?before=pageParams[index]`. `mergeNewestPage` only speaks
 * for the newest page's range, so an edit, delete, reaction or media-ready on
 * an older loaded message that happened while we were away would otherwise
 * stay wrong for as long as the chat stays open.
 *
 * Authoritative over `[max(page's own lo, fetched floor), hi)`: inside it,
 * cached rows take the server's copy or are dropped if the server omitted
 * them (deleted), and fetched rows we lacked (restored) are added. Rows the
 * fetch reached below the page's own range belong to the next page down and
 * are left for that page's own pass. No gap/reset rule here: a page whose
 * cursor is unchanged can't have a gap.
 */
export function reconcileOlderPage(cache: MessagesCache, index: number, fetched: MessagesResponse): MessagesCache {
  const target = cache.pages[index];
  if (index < 1 || !target) return cache;
  const bounds = pageBounds(cache, index);
  // `nextCursor === null` ⇒ the server says nothing exists below this fetch,
  // so the whole page range is covered; otherwise only down to its oldest row.
  const oldest = fetched.messages[fetched.messages.length - 1];
  const fetchedFloor = fetched.nextCursor === null || !oldest ? null : BigInt(oldest.id);
  const lo = bounds.lo === null ? fetchedFloor : fetchedFloor === null || bounds.lo > fetchedFloor ? bounds.lo : fetchedFloor;
  const covered = (id: bigint) => inBounds(id, { lo, hi: bounds.hi });

  const byId = new Map(fetched.messages.map((m) => [m.id, m]));
  const messages = target.messages.flatMap((m) => {
    if (isLocalId(m.id)) return [m];
    const server = byId.get(m.id);
    if (server) return [server];
    return covered(BigInt(m.id)) ? [] : [m];
  });
  const have = new Set(messages.map((m) => m.id));
  const added = fetched.messages.filter((m) => !have.has(m.id) && covered(BigInt(m.id)));

  const pages = cache.pages.slice();
  pages[index] = { ...target, messages };
  // Through `insertMessages` so an id that somehow sits on another page is
  // replaced there rather than duplicated here.
  return insertMessages({ ...cache, pages }, added) ?? { ...cache, pages };
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
