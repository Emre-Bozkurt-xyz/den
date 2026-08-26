/**
 * Who is typing, client side (docs/TYPING_INDICATORS.md §2).
 *
 * ⚠️ **Deliberately NOT React state in the realtime provider.** Nothing in
 * `ChatView` is memoized (PROJECT.md §13 icebox), so any state change in the
 * provider re-renders every block, media bubble, embed card and receipt row on
 * screen. A typing indicator changing every few seconds is exactly the kind of
 * frequent, cosmetic update that would make that cost visible. An external
 * store read through `useSyncExternalStore` means only the one component
 * showing the indicator re-renders.
 *
 * The server already expires stale claims; the client expiry here is the
 * belt-and-braces third defence — if a `typing: false` frame is dropped, the
 * indicator still clears rather than sticking forever.
 */
import { useSyncExternalStore } from 'react';
import { TypingTimings } from '@den/shared';

type Listener = () => void;

const listeners = new Set<Listener>();
/** chatId → userId → the client-side expiry timer for that claim. */
const typers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
/**
 * chatId → the last array handed out for it.
 *
 * ⚠️ `useSyncExternalStore` calls `getSnapshot` on every render and throws
 * "The result of getSnapshot should be cached" if it returns a fresh array
 * each time. Rebuilding only when the set actually changes keeps the identity
 * stable between renders AND is what makes the subscription cheap.
 */
const snapshots = new Map<string, string[]>();

const EMPTY: string[] = [];

function notify(): void {
  for (const l of listeners) l();
}

function rebuild(chatId: string): void {
  const set = typers.get(chatId);
  snapshots.set(chatId, set && set.size > 0 ? [...set.keys()] : EMPTY);
  notify();
}

/** Apply a `typing.state` frame from the server. */
export function applyTypingState(chatId: string, userId: string, typing: boolean): void {
  let set = typers.get(chatId);

  if (!typing) {
    const timer = set?.get(userId);
    if (!timer) return; // nothing to clear — don't churn the snapshot
    clearTimeout(timer);
    set!.delete(userId);
    if (set!.size === 0) typers.delete(chatId);
    rebuild(chatId);
    return;
  }

  if (!set) {
    set = new Map();
    typers.set(chatId, set);
  }
  const existing = set.get(userId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    const current = typers.get(chatId);
    current?.delete(userId);
    if (current && current.size === 0) typers.delete(chatId);
    rebuild(chatId);
  }, TypingTimings.clientExpiryMs);
  set.set(userId, timer);

  // Only rebuild when the membership actually changed — a refresh from someone
  // already listed is a timer reset, not a new fact for React to hear about.
  if (!existing) rebuild(chatId);
}

/** Drop everything — used on reconnect, where any prior state is unreliable. */
export function clearAllTyping(): void {
  for (const set of typers.values()) {
    for (const timer of set.values()) clearTimeout(timer);
  }
  typers.clear();
  snapshots.clear();
  notify();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The user ids currently typing in `chatId`. Stable identity between changes. */
export function useTypers(chatId: string): string[] {
  return useSyncExternalStore(
    subscribe,
    () => snapshots.get(chatId) ?? EMPTY,
    () => EMPTY,
  );
}
