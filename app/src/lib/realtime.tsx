import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import {
  WsType,
  makeEnvelope,
  type WsEnvelope,
  type ChatReceipt,
  type Message,
  type EmbedReadyPayload,
  type MediaReadyPayload,
  type MessageDeletedPayload,
  type MessageDeliveredPayload,
  type MessageEditedPayload,
  type MessageNewPayload,
  type MessageReadPayload,
  type MessageRestoredPayload,
  type MeResponse,
  type ReactionAddedPayload,
  type ReactionRemovedPayload,
  type ReactionSummary,
  type ReceiptsResponse,
  type ReplyPreview,
  type TagAddedPayload,
  type TypingStatePayload,
  TypingTimings,
} from '@den/shared';
import { fetchMessages } from './chats';
import {
  applyServerMessage,
  deliveredReqIds,
  insertMessages,
  mergeNewestPage,
  reconcileOlderPage,
  type MessagesCache,
} from './messageSync';
import { connectSocket, reviveSocket } from './socket';
import { setChatBadge } from './push';
import { useChats } from '../hooks/useChats';

/** How long an optimistic send waits for the server's `message.new` echo
 *  before flipping the bubble to `failed:` (docs/RECEIPTS.md §5.3) — the
 *  socket may be technically "connected" (per socket.io) yet the request
 *  never round-trips (a bad network, a server hiccup); this is the backstop
 *  for that case, distinct from the "no socket at all" immediate-failed path
 *  in `sendMessage` below. */
const SEND_TIMEOUT_MS = 10_000;

/** Local (never-reached-the-server) message ids — an in-flight optimistic
 *  send (`pending:<reqId>`) or one that definitively didn't make it
 *  (`failed:<reqId>`). Shared by every "is this a real, server-assigned
 *  message" check across the app (docs/RECEIPTS.md §5.3) so pending/failed
 *  bookkeeping never drifts out of sync between call sites. */
export function isPendingId(id: string): boolean {
  return id.startsWith('pending:');
}
export function isFailedId(id: string): boolean {
  return id.startsWith('failed:');
}
export function isLocalId(id: string): boolean {
  return isPendingId(id) || isFailedId(id);
}

import { applyTypingState, clearAllTyping } from './typing';

interface RealtimeCtx {
  connected: boolean;
  /** Optimistic text send: inserts a pending bubble, emits message.send, and
   *  reconciles it (or rolls it back) when the server replies — matched by
   *  the envelope's `reqId` (BACKBONE §4). `replyToId`/`replyPreview`
   *  (post-MVP) are optional: when set, the WS payload carries `replyToId`
   *  and the optimistic bubble shows `replyPreview` immediately, ahead of the
   *  server's authoritative `message.new` reconciling it. No socket (or a
   *  known-disconnected one) inserts the bubble as `failed:<reqId>` directly
   *  instead of silently no-oping (docs/RECEIPTS.md §5.3/§1). */
  sendMessage: (chatId: string, body: string, replyToId?: string, replyPreview?: ReplyPreview) => void;
  /** docs/GIFS.md §6 — picking a GIF sends it immediately. */
  sendGif: (chatId: string, gif: { slug: string; width: number; height: number; title: string }, replyToId?: string, replyPreview?: ReplyPreview) => void;
  /** docs/RECEIPTS.md §5.3 — swaps the failed bubble for a pending one and
   *  resends its original args under the SAME reqId: the reqId is the
   *  server's idempotency key, so a retry of a send that actually landed
   *  (lost ack) gets the original message back instead of a copy. No-op if
   *  `failedId` isn't a known failed id (e.g. already retried/discarded). */
  retrySend: (failedId: string) => void;
  /** docs/RECEIPTS.md §5.3 — removes a failed bubble for good; client-only
   *  state, so there's nothing server-side to undo. */
  discardFailed: (failedId: string) => void;
  /** Post-MVP reactions: records that *this* client just optimistically
   *  applied its own add/remove for `key` (see `reactionPendingKey`) so the
   *  server's echo of that same event back to this socket is recognized as a
   *  confirmation and skipped rather than double-applied. Call right before
   *  (or as part of) the optimistic cache update — see `ChatView.toggleReaction`. */
  notePendingReaction: (key: string) => void;
  /** Clears a pending-reaction key without waiting for the echo — used when
   *  the REST call itself fails, so no confirmation frame will ever arrive
   *  (rolling back the optimistic change is the caller's job; this only
   *  stops the key from leaking). */
  clearPendingReaction: (key: string) => void;
  /**
   * Report which chat is on screen, or `null` for none (docs/NOTIFICATIONS.md
   * §2.1). `ChatView` calls it on mount and clears it on unmount; this
   * provider owns re-reporting it on visibility edges and reconnects.
   *
   * Its one consumer is push targeting on the server. Room membership can't
   * answer "is this user looking at this chat" — every socket joins every one
   * of its user's rooms — so without this report a backgrounded PWA holding a
   * live socket silently suppressed its own notifications.
   */
  setActiveChat: (chatId: string | null) => void;
  /**
   * Report that the user is (or has stopped) typing in `chatId`
   * (docs/TYPING_INDICATORS.md §3).
   *
   * ⚠️ Call this on every keystroke — the throttling lives HERE, not in the
   * caller, so there is exactly one place that decides the wire rate and it
   * cannot drift from `TypingTimings.serverExpiryMs`. `typing: false` is never
   * throttled: a stop must go out immediately or the indicator lingers.
   */
  sendTyping: (chatId: string, typing: boolean) => void;
}

const Ctx = createContext<RealtimeCtx>({
  connected: false,
  sendMessage: () => {},
  sendGif: () => {},
  retrySend: () => {},
  discardFailed: () => {},
  notePendingReaction: () => {},
  clearPendingReaction: () => {},
  setActiveChat: () => {},
  sendTyping: () => {},
});

export function useRealtime(): RealtimeCtx {
  return useContext(Ctx);
}

// Defined in `lib/messageSync.ts` (which must not import this file), re-exported
// here because this is where the rest of the app already reaches for it.
export type { MessagesCache };

function withFirstPage(cache: MessagesCache | undefined, update: (messages: Message[]) => Message[]): MessagesCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  const pages = cache.pages.slice();
  const first = pages[0]!;
  pages[0] = { ...first, messages: update(first.messages) };
  return { ...cache, pages };
}

/** Like `withFirstPage`, but applies across every page — a bulk delete (or a
 *  reaction, post-MVP) can land on a message on any loaded page, not just the
 *  newest one (docs/archive/MESSAGE_DELETE.md §4). Exported for `ChatView`'s
 *  `toggleReaction`, which needs the exact same whole-cache update shape for
 *  its optimistic apply/rollback. */
export function withAllPages(cache: MessagesCache | undefined, update: (messages: Message[]) => Message[]): MessagesCache | undefined {
  if (!cache) return cache;
  return { ...cache, pages: cache.pages.map((p) => ({ ...p, messages: update(p.messages) })) };
}

/** Dedup key for the "did I just apply this myself" check described on
 *  `RealtimeCtx.notePendingReaction` — shared by the optimistic apply
 *  (`ChatView.toggleReaction`) and the WS reconciliation below so both sides
 *  always agree on the exact same string. */
export function reactionPendingKey(messageId: string, emoji: string, action: 'add' | 'remove'): string {
  return `${messageId}:${emoji}:${action}`;
}

/** Pure reducer: one emoji's `ReactionSummary` after `userId` added a
 *  reaction. Shared by the WS handler (`userId` = whoever reacted) and
 *  `ChatView`'s optimistic apply (`userId` = `meId`) — a single source of
 *  truth for "what does adding a reaction do to the list", so the two paths
 *  can never drift out of sync with each other. */
export function applyReactionAdded(reactions: ReactionSummary[], emoji: string, userId: string, meId: string): ReactionSummary[] {
  const idx = reactions.findIndex((r) => r.emoji === emoji);
  if (idx === -1) return [...reactions, { emoji, count: 1, mine: userId === meId }];
  const r = reactions[idx]!;
  const next: ReactionSummary = { ...r, count: r.count + 1, mine: r.mine || userId === meId };
  return reactions.map((rr, i) => (i === idx ? next : rr));
}

/** Pure reducer: the inverse of `applyReactionAdded`. Drops the summary
 *  entirely once its count hits 0 rather than leaving a `{count: 0}` husk. */
export function applyReactionRemoved(reactions: ReactionSummary[], emoji: string, userId: string, meId: string): ReactionSummary[] {
  const idx = reactions.findIndex((r) => r.emoji === emoji);
  if (idx === -1) return reactions;
  const r = reactions[idx]!;
  const count = r.count - 1;
  if (count <= 0) return reactions.filter((_, i) => i !== idx);
  return reactions.map((rr, i) => (i === idx ? { ...rr, count, mine: userId === meId ? false : rr.mine } : rr));
}

/** Args needed to (re)send a text message — captured at `sendMessage` time
 *  and kept in `failedRef` (keyed by reqId) so `retrySend` can replay them
 *  without the caller re-supplying anything (docs/RECEIPTS.md §5.3). */
interface PendingSendArgs {
  chatId: string;
  body: string;
  replyToId?: string;
  replyPreview?: ReplyPreview;
  /** docs/GIFS.md §6 — set when this send is a picked GIF rather than text.
   *  Only `slug` is ever transmitted; `width`/`height`/`title` are local
   *  display hints, taken from the search result the user just tapped, so the
   *  optimistic placeholder can reserve the right box immediately. They are
   *  deliberately never sent to the server (invariant 7 — the server re-fetches
   *  and derives its own), and the real values arrive with `embed.ready`. */
  gif?: { slug: string; width: number; height: number; title: string };
}

function buildOptimisticMessage(id: string, args: PendingSendArgs, senderId: string): Message {
  const base: Omit<Message, 'kind' | 'body' | 'embed'> = {
    id,
    chatId: args.chatId,
    senderId,
    createdAt: new Date().toISOString(),
    media: [],
    replyTo: args.replyPreview ?? null,
    reactions: [],
    editedAt: null,
  };

  if (args.gif) {
    // Mirrors exactly what the server will mint (embeds/service.ts's
    // 'processing' row), so the real `message.new` replaces this without the
    // card changing shape or size under the reader.
    return {
      ...base,
      kind: 'embed',
      body: null,
      embed: {
        id: `optimistic:${args.gif.slug}`,
        provider: 'klipy',
        status: 'processing',
        title: args.gif.title,
        subtitle: null,
        description: null,
        // The slug we're sending — but note it may still be the *suffixed*
        // search-result form here (docs/GIFS.md §12); the server replaces this
        // row with the canonical one moments later. Harmless either way: a
        // pending bubble is excluded from the focus menu, so nothing reads
        // this before `message.new` overwrites it.
        providerRef: args.gif.slug,
        thumbUrl: null,
        canonicalUrl: null,
        contentKind: 'gif',
        actionType: 'inline',
        width: args.gif.width,
        height: args.gif.height,
      },
    };
  }

  return { ...base, kind: 'text', body: args.body, embed: null };
}

/**
 * Owns the single socket.io connection for the session and feeds every
 * `WsEnvelope` frame into the TanStack Query cache. Server is the source of
 * truth (hard invariant 3): on connect/reconnect we invalidate and refetch —
 * we never try to replay frames missed while offline.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  // reqId -> the optimistic message id it should replace, so multiple tabs/
  // devices on the same account don't step on each other's pending sends.
  // docs/RECEIPTS.md §5.3: stays populated across a pending→failed rename
  // (only the stored `tempId` changes) so a late `message.new` echo can still
  // find and reconcile it; only removed once the send is truly resolved
  // (echo arrives, a catch-up page carries its nonce, the server sends
  // `error`, or it's discarded — see `settleSend`). A Retry reuses the reqId,
  // so it overwrites its own entry instead of orphaning the old one.
  const pendingRef = useRef(new Map<string, { chatId: string; tempId: string }>());
  // docs/RECEIPTS.md §5.3: reqId -> the original send args, kept alongside
  // (and slightly longer than) `pendingRef` so `retrySend` can replay a
  // failed send without the caller re-supplying anything. Only cleared on a
  // confirmed success or an explicit discard — an `error` frame or a local
  // send-timeout both leave it in place, since that's exactly when a retry
  // becomes possible.
  const failedRef = useRef(new Map<string, PendingSendArgs>());
  // reqId -> the pending→failed timeout (docs/RECEIPTS.md §5.3's 10s
  // backstop) — cleared whenever the send resolves before it fires.
  const sendTimeoutsRef = useRef(new Map<string, number>());
  // Post-MVP reactions: `reactionPendingKey`s this client just optimistically
  // applied itself and is waiting to see echoed back — see
  // `RealtimeCtx.notePendingReaction`'s doc comment for the double-count trap
  // this exists to avoid.
  const pendingReactionsRef = useRef(new Set<string>());
  // Chat ids with a catch-up fetch in flight — a resume can fire visibility
  // and `connect` within the same second, and the second one would otherwise
  // duplicate the request.
  const resyncingRef = useRef(new Set<string>());

  // docs/RECEIPTS.md §5.2: once every chat's `lastMessage` id is known (first
  // load, and again whenever `['chats']` refetches — notably right after a
  // reconnect's invalidate below), batch-ack them all in one frame. This is
  // what turns "I was offline while you sent this" into a `Delivered` for the
  // sender without the recipient ever opening the chat.
  const { data: chatsData } = useChats();
  useEffect(() => {
    if (!chatsData) return;
    const items = chatsData.chats
      .filter((c) => c.lastMessage && !isLocalId(c.lastMessage.id))
      .map((c) => ({ chatId: c.id, messageId: c.lastMessage!.id }));
    sendDeliveredAck(items);
  }, [chatsData]);

  // App badge (docs/NOTIFICATIONS.md §5 / D4) — chats with something waiting,
  // not messages. The SW writes the same number from its notification count
  // while the app is closed; this is the running app's half, and it lives here
  // because `['chats']` is already subscribed here (a second subscriber in
  // `AuthedApp` would re-render the whole tree on every chat update).
  useEffect(() => {
    if (!chatsData) return;
    setChatBadge(chatsData.chats.filter((c) => c.unreadCount > 0).length);
  }, [chatsData]);

  /** Fire-and-forget delivery ack (docs/RECEIPTS.md §4.2/§5.2) — a hint, not
   *  a request: no reply is expected, and a disconnected socket just drops
   *  it (the next reconnect's batch-ack above covers the gap). */
  function sendDeliveredAck(items: { chatId: string; messageId: string }[]): void {
    const socket = socketRef.current;
    if (!socket?.connected || items.length === 0) return;
    socket.emit('ws', makeEnvelope(WsType.DeliveredAck, { items }));
  }

  // The chat currently on screen, as last reported by `ChatView`. A ref, not
  // state: nothing renders off it, and every write is followed by an emit —
  // re-rendering the whole provider on a chat switch would be pure churn.
  const activeChatRef = useRef<string | null>(null);

  /**
   * Tell the server what this socket is looking at (docs/NOTIFICATIONS.md
   * §2.1). Fire-and-forget like the delivery ack: a dropped report degrades to
   * "not watching", which means an extra notification rather than a missing
   * one — the safe direction, and the whole reason this exists.
   *
   * Must be re-sent on every reconnect: presence lives on the *socket*, so a
   * new socket starts with none.
   */
  /**
   * chatId → when we last put a `typing: true` on the wire for it. A ref, not
   * state: throttling must not re-render anything.
   */
  const typingSentAtRef = useRef<Map<string, number>>(new Map());

  function sendTyping(chatId: string, typing: boolean): void {
    const socket = socketRef.current;
    if (!socket?.connected) return;

    const sentAt = typingSentAtRef.current;
    if (typing) {
      const last = sentAt.get(chatId) ?? 0;
      // Refresh at half the server's expiry, so one dropped frame can't blink
      // the indicator off mid-sentence.
      if (Date.now() - last < TypingTimings.refreshMs) return;
      sentAt.set(chatId, Date.now());
    } else {
      // A stop is never throttled and always clears the throttle window —
      // otherwise the next keystroke after a send would be swallowed and the
      // indicator wouldn't come back.
      if (!sentAt.has(chatId)) return;
      sentAt.delete(chatId);
    }

    socket.emit('ws', makeEnvelope(WsType.TypingUpdate, { chatId, typing }));
  }

  function sendPresence(): void {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket.emit(
      'ws',
      makeEnvelope(WsType.PresenceUpdate, {
        chatId: activeChatRef.current,
        visible: document.visibilityState === 'visible',
      }),
    );
  }

  // Stable identity, deliberately: `ChatView` lists this in an effect's deps
  // (it is the same effect that clears the chat's notifications), and a fresh
  // function every provider render would re-run that effect constantly —
  // reporting null-then-chat and re-posting to the SW on every keystroke
  // anywhere in the app. `sendPresence` is captured from the first render and
  // reads only refs and `document`, so the stale closure is inert.
  const setActiveChat = useCallback((chatId: string | null): void => {
    if (activeChatRef.current === chatId) return;
    activeChatRef.current = chatId;
    sendPresence();
  }, []);

  /**
   * Presence tracks *both* visibility edges, unlike the resume handler below
   * which only cares about waking up. Going hidden is the interesting one: it
   * is the moment this device stops being a reason to withhold a notification,
   * and reporting it late is exactly the "message arrived while the screen was
   * off and nothing told me" failure this pass is fixing.
   */
  useEffect(() => {
    document.addEventListener('visibilitychange', sendPresence);
    return () => document.removeEventListener('visibilitychange', sendPresence);
    // `sendPresence` is recreated every render but reads everything through
    // refs, so re-registering the listener each time would be churn.
  }, []);

  /** Clears a send's 10s failure-timeout once it resolves some other way
   *  (echo arrived, server errored) — see `sendMessage`'s own timeout below. */
  function clearSendTimeout(reqId: string): void {
    const t = sendTimeoutsRef.current.get(reqId);
    if (t !== undefined) {
      window.clearTimeout(t);
      sendTimeoutsRef.current.delete(reqId);
    }
  }

  /** Drops every bit of bookkeeping for a send that is now settled for good —
   *  delivered (echo/ack, or a catch-up page carrying its nonce) or
   *  discarded. One place, so no path can forget one of the three maps. */
  function settleSend(reqId: string): void {
    pendingRef.current.delete(reqId);
    failedRef.current.delete(reqId);
    clearSendTimeout(reqId);
  }

  /** Chats currently being *looked at* — one on mobile, up to two in the
   *  desktop split view. Read off the query cache rather than threaded down
   *  from `AuthedApp`, so nothing above here has to know that resync exists. */
  function activeChatIds(): string[] {
    return qc
      .getQueryCache()
      .findAll({ queryKey: ['messages'], type: 'active' })
      .map((q) => q.queryKey[1])
      .filter((id): id is string => typeof id === 'string');
  }

  /**
   * Catch one open chat up to the server, cheaply: fetch the newest page and
   * merge it (`lib/messageSync.ts` — see its doc for the delete/gap rules).
   *
   * This deliberately replaces what used to be
   * `invalidateQueries({ queryKey: ['messages'] })` on reconnect. That looks
   * like one line of "server is truth" but on an infinite query it refetches
   * **every loaded page, one after another** — so the more history the reader
   * had scrolled through, the longer the chat sat frozen after waking up,
   * while backing out and coming in again (a fresh mount, one page) was
   * instant. Catching up is inherently a one-page problem: the messages we
   * missed are the newest ones.
   */
  function resyncChat(chatId: string): void {
    if (resyncingRef.current.has(chatId)) return;
    resyncingRef.current.add(chatId);
    void fetchMessages(chatId, null)
      .then(async (page) => {
        qc.setQueryData<MessagesCache>(['messages', chatId], (old) => mergeNewestPage(old, page));
        // The merge just dropped any bubble this page proved delivered (its
        // nonce came back on our own row) — its timers/args go with it.
        for (const reqId of deliveredReqIds(page)) settleSend(reqId);
        await resyncOlderPages(chatId);
      })
      // A failed catch-up is not worth surfacing: the query is already marked
      // stale, so a remount refetches, and the next resume tries again.
      .catch(() => {})
      .finally(() => resyncingRef.current.delete(chatId));
  }

  /**
   * The deeper loaded pages of an open chat, re-validated one at a time AFTER
   * the newest page has merged — so the reader sees new messages first, and
   * this is background work, never the "frozen until N pages land" refetch
   * `resyncChat` exists to avoid. Without it, an edit/delete/reaction/
   * media-ready on an older message that happened while we were away stayed
   * wrong until the chat was closed and reopened (a desktop split view or a
   * PWA left on one chat could go days). Sequential and bounded by what's
   * loaded (usually 1–3 pages). Chose this over trimming the cache to page 0:
   * a reader scrolled up in history would watch their content vanish.
   *
   * Each pass re-reads the cache and only applies if page `i` still has the
   * cursor it was fetched with — a gap-reset or a remount in between just
   * ends the walk. A live frame landing mid-fetch can be overwritten by the
   * slightly older fetched copy; the same (pre-existing) race as
   * `mergeNewestPage`, and the next resume corrects it.
   */
  async function resyncOlderPages(chatId: string): Promise<void> {
    const loaded = qc.getQueryData<MessagesCache>(['messages', chatId])?.pages.length ?? 0;
    for (let i = 1; i < loaded; i++) {
      const before = qc.getQueryData<MessagesCache>(['messages', chatId])?.pageParams[i];
      if (typeof before !== 'string') return;
      const fetched = await fetchMessages(chatId, before);
      qc.setQueryData<MessagesCache>(['messages', chatId], (old) =>
        old && old.pageParams[i] === before ? reconcileOlderPage(old, i, fetched) : old,
      );
    }
  }

  /** Everything a wake-up owes the user, in the order they'll notice it. */
  function resync(): void {
    for (const chatId of activeChatIds()) resyncChat(chatId);
    // Server is truth (hard invariant 3): every non-message query that a WS
    // frame would have patched or invalidated is refetched (active) or marked
    // stale (inactive) rather than trusting frames missed while we were away:
    // chat list (message.new/deleted/…), receipts (message.read/delivered),
    // friends (friend.*), gallery + per-media tags (tag.*, media.ready),
    // search results (edits/deletes change what a result shows). Messages are
    // handled per-chat above and below.
    for (const key of ['chats', 'receipts', 'friends', 'gallery', 'mediaTags', 'messageSearch']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
    // Chats that aren't on screen only get marked stale — they refetch when
    // next opened, which is exactly when their contents start mattering.
    void qc.invalidateQueries({ queryKey: ['messages'], refetchType: 'none' });
  }

  /**
   * Waking up is its own event, distinct from reconnecting, and the app has to
   * treat it as one (owner report, 2026-08-23: a message that arrived while
   * the phone was locked showed up as a push and as an unread badge in the
   * chat list, but the chat that was already open didn't move).
   *
   * Nothing else covers it. The socket may be a zombie for most of a minute
   * before it even notices (see `reviveSocket`), so no `connect` fires;
   * `refetchOnWindowFocus` is off for messages precisely because its version
   * of "refetch" is the N-page storm above (`hooks/useMessages.ts`). So on
   * every visible/online edge: kick the socket *and* catch up over REST,
   * concurrently. They're redundant on purpose — whichever wins, the reader
   * sees the message, and the merge is idempotent.
   */
  useEffect(() => {
    function onResume() {
      if (document.visibilityState !== 'visible') return;
      const socket = socketRef.current;
      if (socket) reviveSocket(socket);
      resync();
    }
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('online', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('online', onResume);
    };
    // `resync` is recreated every render but closes over nothing that changes
    // (`qc` and the refs are all stable), and the socket is read through a
    // ref — re-registering these listeners on every render would be churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // Presence is per-socket server-side, so a fresh socket knows nothing
      // about what the user is looking at until we say so (§2.1). Before
      // `resync`, so a message landing in the same breath as the reconnect is
      // judged against the truth rather than the default.
      sendPresence();
      resync();
    });
    socket.on('disconnect', () => {
      setConnected(false);
      // Typing state is per-socket on the server, so everything we believe
      // about it dies with the connection. Keeping it would leave indicators
      // frozen on screen for the client expiry while the truth is already
      // gone (docs/TYPING_INDICATORS.md §2).
      clearAllTyping();
    });

    socket.on('ws', (frame: WsEnvelope) => {
      switch (frame.type) {
        case WsType.MessageNew: {
          const { message } = frame.payload as MessageNewPayload;

          // Matched by reqId → bubble id (`pending:`/`failed:<reqId>`), not
          // via `pendingRef`, so a late ack still lands after a timeout,
          // after a Retry (same reqId), or after a catch-up merge already
          // brought the row in — in which case the bubble is just dropped
          // (`applyServerMessage` never inserts an id twice). Other members'
          // copies of a broadcast carry the sender's reqId too; they have no
          // bubble by that id, so it's inert for them.
          qc.setQueryData<MessagesCache>(['messages', message.chatId], (old) =>
            applyServerMessage(old, message, frame.reqId),
          );
          if (frame.reqId) settleSend(frame.reqId);
          void qc.invalidateQueries({ queryKey: ['chats'] });
          // docs/RECEIPTS.md §5.2 — every landed message (mine or another
          // member's) gets acked, unconditionally: the server only advances
          // (and only broadcasts) on a real watermark move, so acking our own
          // echo is a harmless no-op, cheaper than branching around it.
          sendDeliveredAck([{ chatId: message.chatId, messageId: message.id }]);
          break;
        }
        case WsType.Error: {
          const pending = frame.reqId ? pendingRef.current.get(frame.reqId) : undefined;
          if (pending && frame.reqId) {
            // docs/RECEIPTS.md §5.3: the server definitively rejected this
            // send — rename the bubble to `failed:` (never silently drop it)
            // and stop tracking it as pending (no echo will ever arrive), but
            // keep `failedRef` so `retrySend` still has the original args.
            const failedId = `failed:${frame.reqId}`;
            qc.setQueryData<MessagesCache>(['messages', pending.chatId], (old) =>
              withFirstPage(old, (messages) => messages.map((m) => (m.id === pending.tempId ? { ...m, id: failedId } : m))),
            );
            pendingRef.current.delete(frame.reqId);
            clearSendTimeout(frame.reqId);
          }
          break;
        }
        case WsType.MediaReady: {
          const { message } = frame.payload as MediaReadyPayload;
          // Every page, not just the first: a placeholder that has scrolled
          // off page 0 (busy chat, slow transcode) must still flip to ready.
          qc.setQueryData<MessagesCache>(['messages', message.chatId], (old) =>
            withAllPages(old, (messages) => messages.map((m) => (m.id === message.id ? message : m))),
          );
          void qc.invalidateQueries({ queryKey: ['chats'] });
          sendDeliveredAck([{ chatId: message.chatId, messageId: message.id }]);
          break;
        }
        case WsType.EmbedReady: {
          // docs/EMBEDS.md §4.2 — identical handling to MediaReady above: the
          // resolved card replaces the 'processing' placeholder in place.
          const { message } = frame.payload as EmbedReadyPayload;
          qc.setQueryData<MessagesCache>(['messages', message.chatId], (old) =>
            withAllPages(old, (messages) => messages.map((m) => (m.id === message.id ? message : m))),
          );
          void qc.invalidateQueries({ queryKey: ['chats'] });
          sendDeliveredAck([{ chatId: message.chatId, messageId: message.id }]);
          break;
        }
        case WsType.TypingState: {
          const p = frame.payload as TypingStatePayload;
          applyTypingState(p.chatId, p.userId, p.typing === true);
          break;
        }
        case WsType.MessageDelivered:
        case WsType.MessageRead: {
          // Both frames patch the same `['receipts', chatId]` shape — only
          // which field advances differs. Client-side guarded-monotonic
          // apply (docs/RECEIPTS.md §3): frames can race (a fast follow-up
          // read arriving before an earlier delivered ack, a duplicate on
          // reconnect), so a frame whose id isn't strictly newer than what's
          // already cached is a no-op, same rule the server enforces on write.
          const isRead = frame.type === WsType.MessageRead;
          const { chatId, userId, messageId } = frame.payload as MessageDeliveredPayload | MessageReadPayload;
          qc.setQueryData<ReceiptsResponse>(['receipts', chatId], (old) => {
            if (!old) return old;
            const idx = old.receipts.findIndex((r) => r.userId === userId);
            if (idx === -1) return old; // unknown member row — nothing to patch
            const current = old.receipts[idx]!;
            const currentVal = isRead ? current.lastReadMessageId : current.lastDeliveredMessageId;
            if (currentVal !== null && BigInt(currentVal) >= BigInt(messageId)) return old;
            const next: ChatReceipt = isRead
              ? { ...current, lastReadMessageId: messageId }
              : { ...current, lastDeliveredMessageId: messageId };
            const receipts = old.receipts.slice();
            receipts[idx] = next;
            return { receipts };
          });
          // A cross-device read of MY OWN watermark clears the unread badge
          // on every other device without a manual refetch (docs/RECEIPTS.md
          // §5.1's "cross-device unread-badge sync for free").
          if (isRead && userId === qc.getQueryData<MeResponse | null>(['me'])?.id) {
            void qc.invalidateQueries({ queryKey: ['chats'] });
          }
          break;
        }
        case WsType.ChatCreated:
          void qc.invalidateQueries({ queryKey: ['chats'] });
          break;
        case WsType.MessageDeleted: {
          const { chatId, messageIds } = frame.payload as MessageDeletedPayload;
          const ids = new Set(messageIds);
          qc.setQueryData<MessagesCache>(['messages', chatId], (old) =>
            withAllPages(old, (messages) => messages.filter((m) => !ids.has(m.id))),
          );
          // Deleting the newest message changes the chat-list preview and
          // unread count — not optional (docs/archive/MESSAGE_DELETE.md §3).
          void qc.invalidateQueries({ queryKey: ['chats'] });
          break;
        }
        case WsType.MessageEdited: {
          // Idempotent replace across every loaded page (docs/MESSAGE_EDIT.md
          // §4.1) — an edit can land on any page, not just the newest, and
          // applying REST-first already patched this client's own cache, so
          // re-applying the same replacement here is a harmless no-op rather
          // than something that needs echo-dedup bookkeeping.
          const { chatId, message } = frame.payload as MessageEditedPayload;
          qc.setQueryData<MessagesCache>(['messages', chatId], (old) =>
            withAllPages(old, (messages) => messages.map((m) => (m.id === message.id ? message : m))),
          );
          // Editing the newest message changes the chat-list preview — same
          // rule as delete/restore.
          void qc.invalidateQueries({ queryKey: ['chats'] });
          break;
        }
        case WsType.MessageRestored: {
          const { chatId, messages: restored } = frame.payload as MessageRestoredPayload;
          // Each restored message goes back onto the page whose id range owns
          // it (`insertMessages`) — piling them all onto page 0 sorted an old
          // one below page 1's newest row. One older than anything loaded is
          // left for pagination to fetch.
          qc.setQueryData<MessagesCache>(['messages', chatId], (old) => insertMessages(old, restored));
          void qc.invalidateQueries({ queryKey: ['chats'] });
          break;
        }
        case WsType.FriendRequest:
        case WsType.FriendAccepted:
          void qc.invalidateQueries({ queryKey: ['friends'] });
          break;
        case WsType.TagAdded: {
          // docs/MEDIA_ATTACHMENTS.md §4.5/D7 — re-blurs (or unblurs, on the
          // 'nsfw'-wins edge) live for everyone, in the same frame, without
          // waiting on a refetch. The payload carries the full `Tag` (with
          // its name), so this is a direct patch rather than an invalidate:
          // find the message carrying this mediaId across every loaded chat
          // (the payload has no chatId to scope the search to one) and patch
          // that one item's `sensitivity`. Non-sensitive tag names (the vast
          // majority) are a no-op here — `sensitivity` only ever reflects
          // SENSITIVE_TAGS.
          const { mediaId, tag } = frame.payload as TagAddedPayload;
          if (tag.name === 'nsfw' || tag.name === 'spoiler') {
            qc.setQueriesData<MessagesCache>({ queryKey: ['messages'] }, (old) =>
              withAllPages(old, (messages) =>
                messages.map((m) =>
                  m.media.some((med) => med.id === mediaId)
                    ? {
                        ...m,
                        media: m.media.map((med) =>
                          med.id === mediaId
                            ? { ...med, sensitivity: tag.name === 'nsfw' ? 'nsfw' : (med.sensitivity ?? 'spoiler') }
                            : med,
                        ),
                      }
                    : m,
                ),
              ),
            );
          }
          void qc.invalidateQueries({ queryKey: ['gallery'] });
          void qc.invalidateQueries({ queryKey: ['mediaTags'] });
          break;
        }
        case WsType.TagRemoved:
          // Unlike TagAdded, this payload carries only `mediaId`/`tagId` —
          // no tag name (see TagRemovedPayload in shared/src/ws.ts) — so the
          // client cannot tell locally whether the detached tag was 'nsfw',
          // 'spoiler', or an unrelated descriptive tag, nor (if the item
          // carries both reserved tags) which one should still win. Rather
          // than guess, fall back to a refetch: invalidating the messages
          // caches too (in addition to gallery/mediaTags) means every open
          // chat re-fetches and picks up the server's authoritative
          // `sensitivity` — "server is truth" (CLAUDE.md invariant 3), just
          // via a round trip instead of an instant patch. Flagged in the
          // implementation report: if this ever needs to be instant too, add
          // the removed tag's name to `TagRemovedPayload`.
          void qc.invalidateQueries({ queryKey: ['gallery'] });
          void qc.invalidateQueries({ queryKey: ['mediaTags'] });
          void qc.invalidateQueries({ queryKey: ['messages'] });
          break;
        case WsType.ReactionAdded:
        case WsType.ReactionRemoved: {
          const isAdd = frame.type === WsType.ReactionAdded;
          const { chatId, messageId, emoji, userId } = frame.payload as ReactionAddedPayload | ReactionRemovedPayload;
          const meId = qc.getQueryData<MeResponse | null>(['me'])?.id;
          const key = reactionPendingKey(messageId, emoji, isAdd ? 'add' : 'remove');

          // This is the echo of our own optimistic toggle (see
          // `ChatView.toggleReaction`) — already applied locally, so consume
          // the pending marker and skip re-applying instead of double-counting.
          // Frames from other users' sockets never match a key we set, so
          // they always fall through to the apply below.
          if (userId === meId && pendingReactionsRef.current.has(key)) {
            pendingReactionsRef.current.delete(key);
            break;
          }

          qc.setQueryData<MessagesCache>(['messages', chatId], (old) =>
            withAllPages(old, (messages) =>
              messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      reactions: isAdd
                        ? applyReactionAdded(m.reactions, emoji, userId, meId ?? '')
                        : applyReactionRemoved(m.reactions, emoji, userId, meId ?? ''),
                    }
                  : m,
              ),
            ),
          );
          break;
        }
        default:
          break;
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
      pendingRef.current.clear();
      failedRef.current.clear();
      for (const t of sendTimeoutsRef.current.values()) window.clearTimeout(t);
      sendTimeoutsRef.current.clear();
      pendingReactionsRef.current.clear();
    };
    // `resync` — same story as the resume effect above: recreated every render,
    // stable in everything it closes over. Listing it would tear down and
    // rebuild the socket on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);

  function notePendingReaction(key: string): void {
    pendingReactionsRef.current.add(key);
  }

  function clearPendingReaction(key: string): void {
    pendingReactionsRef.current.delete(key);
  }

  function sendMessage(chatId: string, body: string, replyToId?: string, replyPreview?: ReplyPreview): void {
    const trimmed = body.trim();
    if (!trimmed) return;
    dispatchSend({ chatId, body: trimmed, replyToId, replyPreview });
  }

  /** docs/GIFS.md §6 — "picking is sending" (D4): no caption, no staging, no
   *  confirm step. Routes through the same `dispatchSend` as text so the GIF
   *  inherits optimistic rendering, reqId dedup, the 10s failure backstop and
   *  retry, rather than growing a second send path to keep in sync. */
  function sendGif(chatId: string, gif: NonNullable<PendingSendArgs['gif']>, replyToId?: string, replyPreview?: ReplyPreview): void {
    dispatchSend({ chatId, body: '', replyToId, replyPreview, gif });
  }

  /** `reqId` is passed only by `retrySend` — it MUST be the original one (the
   *  server dedupes on it); every fresh send mints its own. */
  function dispatchSend(args: PendingSendArgs, reqId: string = crypto.randomUUID()): void {
    const { chatId } = args;
    const socket = socketRef.current;
    const me = qc.getQueryData<MeResponse | null>(['me']);
    clearSendTimeout(reqId);

    // No socket at all, or a known-disconnected one — fail immediately
    // rather than trust socket.io's own outbound buffering, which would
    // leave the bubble stuck reading "Sent" with no user-visible signal
    // until some future reconnect (docs/RECEIPTS.md §1/§5.3/§7 item 5).
    if (!socket?.connected) {
      const failedId = `failed:${reqId}`;
      failedRef.current.set(reqId, args);
      const optimistic = buildOptimisticMessage(failedId, args, me?.id ?? '0');
      qc.setQueryData<MessagesCache>(['messages', chatId], (old) => withFirstPage(old, (messages) => [optimistic, ...messages]));
      return;
    }

    const tempId = `pending:${reqId}`;
    const optimistic = buildOptimisticMessage(tempId, args, me?.id ?? '0');

    pendingRef.current.set(reqId, { chatId, tempId });
    failedRef.current.set(reqId, args);
    qc.setQueryData<MessagesCache>(['messages', chatId], (old) => withFirstPage(old, (messages) => [optimistic, ...messages]));
    socket.emit(
      'ws',
      makeEnvelope(
        WsType.MessageSend,
        // Slug + a cosmetic size hint (docs/GIFS.md §6). The hint exists so
        // OTHER members' 'processing' placeholder is already the right shape;
        // the server clamps it and the resolver overwrites it with measured
        // values. The preview URL is never sent — the server derives its own.
        {
          chatId,
          body: args.body,
          ...(args.replyToId ? { replyToId: args.replyToId } : {}),
          ...(args.gif ? { gif: { slug: args.gif.slug, width: args.gif.width, height: args.gif.height } } : {}),
        },
        reqId,
      ),
    );

    // docs/RECEIPTS.md §5.3's 10s backstop: the socket was connected at send
    // time but the round trip itself may still never complete. If nothing
    // reconciled this reqId by the deadline, flip the bubble to `failed:` —
    // `pendingRef`'s entry stays (only its `tempId` changes) so a late echo
    // still finds and reconciles it.
    const timeoutId = window.setTimeout(() => {
      sendTimeoutsRef.current.delete(reqId);
      const pending = pendingRef.current.get(reqId);
      if (!pending) return; // already reconciled or errored
      const failedId = `failed:${reqId}`;
      pendingRef.current.set(reqId, { ...pending, tempId: failedId });
      qc.setQueryData<MessagesCache>(['messages', pending.chatId], (old) =>
        withFirstPage(old, (messages) => messages.map((m) => (m.id === pending.tempId ? { ...m, id: failedId } : m))),
      );
    }, SEND_TIMEOUT_MS);
    sendTimeoutsRef.current.set(reqId, timeoutId);
  }

  function retrySend(failedId: string): void {
    if (!isFailedId(failedId)) return;
    const reqId = failedId.slice('failed:'.length);
    const args = failedRef.current.get(reqId);
    if (!args) return;
    qc.setQueryData<MessagesCache>(['messages', args.chatId], (old) =>
      withFirstPage(old, (messages) => messages.filter((m) => m.id !== failedId)),
    );
    // Same reqId, on purpose (see `RealtimeCtx.retrySend`): if the first
    // attempt actually landed, the server answers with that message rather
    // than inserting a copy. `dispatchSend` re-registers it in `pendingRef`/
    // `failedRef` under the same key, so nothing is left behind under an old
    // one. Straight to `dispatchSend` (not `sendMessage`) so a GIF retries as
    // a GIF rather than as an empty text that `sendMessage` would drop.
    dispatchSend(args, reqId);
  }

  function discardFailed(failedId: string): void {
    if (!isFailedId(failedId)) return;
    const reqId = failedId.slice('failed:'.length);
    const args = failedRef.current.get(reqId);
    // All three maps — a timed-out send keeps its `pendingRef` entry (for a
    // late ack), which used to leak here. If that ack does still arrive, the
    // message shows up: it really was sent, and the server is the truth.
    settleSend(reqId);
    if (!args) return;
    qc.setQueryData<MessagesCache>(['messages', args.chatId], (old) =>
      withFirstPage(old, (messages) => messages.filter((m) => m.id !== failedId)),
    );
  }

  return (
    <Ctx.Provider
      value={{ connected, sendMessage, sendGif, retrySend, discardFailed, notePendingReaction, clearPendingReaction, setActiveChat, sendTyping }}
    >
      {children}
    </Ctx.Provider>
  );
}
