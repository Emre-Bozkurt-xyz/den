import { useRef } from 'react';
import type { Message } from '@den/shared';

/**
 * UI-8a (docs/archive/UI8_CHAT_INSTAGRAM.md) — tracks which message ids should play
 * the "bubble-in" send/receive animation on the *current* render, as opposed
 * to already-known history that must render inert.
 *
 * Three things have to be told apart, all surfacing as "an id that wasn't in
 * `messages` last render":
 *  1. **A genuinely new message** — an optimistic `pending:<reqId>` bubble
 *     just inserted by `sendMessage`, or a real message that just arrived
 *     over WS (ours from another device, or someone else's). Animates.
 *  2. **A pending bubble's reconciliation** — `lib/realtime.tsx` replaces a
 *     `pending:<reqId>` id with the server's real id *in place* (same array
 *     position) once `message.new` confirms the send. The bubble already
 *     played its intro when it was inserted as `pending:`; the real id must
 *     not replay it, or every send would double-animate.
 *  3. **Older history paging in** ("Load older messages") — a whole new
 *     prefix of ids appears at the *front* of the flattened list. This is
 *     history, not a live send/receive, and must never animate, exactly like
 *     the initial page load.
 *
 * The returned `Set` is the *cumulative* set of "should render with the
 * intro class" ids — it only ever grows, never shrinks. That's deliberate:
 * if a message's intro-ness were recomputed fresh every render (true only on
 * the one render right after it arrived, false after), an unrelated re-render
 * arriving mid-animation (e.g. the user typing the next message) would strip
 * the CSS class and abort the animation half-played. Growing-only means the
 * class, once added, is never removed — harmless, since a finished CSS
 * animation just holds its end state either way (see `.animate-bubble-in` in
 * index.css), and the set is bounded by however many messages this chat
 * session has actually rendered.
 */
export function useIntroIds(messages: Message[], meId: string): Set<string> {
  // Every id this hook has ever evaluated (intro or not) — the guard against
  // reprocessing/re-animating an id we've already made a decision about.
  const seenRef = useRef<Set<string>>(new Set());
  // The accumulating "animate this one" result (see file doc above).
  const introRef = useRef<Set<string>>(new Set());
  // Full ordered id list from the previous render, oldest→newest — used to
  // find the "Load older messages" boundary (see below) and, together with
  // `prevPendingRef`, to detect a pending→real reconciliation.
  const prevIdsRef = useRef<string[]>([]);
  const prevPendingRef = useRef<Set<string>>(new Set());
  // False until the first render where `messages` is non-empty — that render
  // seeds every currently-present id as "already seen" (the initial history
  // page) without animating any of them, then every render after evaluates
  // deltas normally.
  const seededRef = useRef(false);

  if (!seededRef.current) {
    if (messages.length === 0) return introRef.current; // still loading — nothing to seed yet
    for (const m of messages) seenRef.current.add(m.id);
    prevIdsRef.current = messages.map((m) => m.id);
    prevPendingRef.current = new Set(messages.filter((m) => m.id.startsWith('pending:')).map((m) => m.id));
    seededRef.current = true;
    return introRef.current; // empty — the initial page never animates
  }

  const prevIds = prevIdsRef.current;
  // Everything before this index in the *current* list is a newly-loaded
  // older page ("Load older messages" prepends to the front of the flattened
  // oldest→newest array) — found by locating where the previously-oldest
  // message now sits. If it can't be found (e.g. that message was deleted in
  // the same render), fall back to treating nothing as pagination — the
  // worst case is a rare double-edge-case animating something that
  // shouldn't, purely cosmetic.
  const boundaryIdx = prevIds.length > 0 ? messages.findIndex((m) => m.id === prevIds[0]) : 0;
  const liveFrom = boundaryIdx === -1 ? 0 : boundaryIdx;

  // Pending bubbles that vanished since last render either reconciled into a
  // real id (server confirmed) or were rolled back (send failed, WsType.Error
  // just filters them out). Counted rather than identity-matched — reqId
  // isn't visible at this layer — which is exact for the overwhelmingly
  // common case (one send in flight at a time) and degrades gracefully
  // (worst case, a very rare double-send-at-once mixed with an incoming
  // message from the same sender on another device skips one intro
  // animation it should have played) — cosmetic only, never touches message
  // content or order.
  const currentPendingIds = new Set(messages.filter((m) => m.id.startsWith('pending:')).map((m) => m.id));
  let vanishedPending = 0;
  for (const id of prevPendingRef.current) if (!currentPendingIds.has(id)) vanishedPending++;

  messages.forEach((m, i) => {
    if (seenRef.current.has(m.id)) return;
    seenRef.current.add(m.id);
    if (i < liveFrom) return; // older history paged in — never animates
    if (m.id.startsWith('pending:')) {
      introRef.current.add(m.id); // fresh optimistic bubble
    } else if (vanishedPending > 0 && m.senderId === meId) {
      vanishedPending--; // reconciliation — already animated as the pending bubble
    } else {
      introRef.current.add(m.id); // genuinely new (incoming, or ours with no pending stage)
    }
  });

  prevIdsRef.current = messages.map((m) => m.id);
  prevPendingRef.current = currentPendingIds;
  return introRef.current;
}
