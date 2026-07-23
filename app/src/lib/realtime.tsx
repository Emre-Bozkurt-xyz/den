import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { type InfiniteData, useQueryClient } from '@tanstack/react-query';
import {
  WsType,
  makeEnvelope,
  type WsEnvelope,
  type ChatReceipt,
  type Message,
  type MediaReadyPayload,
  type MessageDeletedPayload,
  type MessageDeliveredPayload,
  type MessageEditedPayload,
  type MessageNewPayload,
  type MessageReadPayload,
  type MessageRestoredPayload,
  type MessagesResponse,
  type MeResponse,
  type ReactionAddedPayload,
  type ReactionRemovedPayload,
  type ReactionSummary,
  type ReceiptsResponse,
  type ReplyPreview,
} from '@den/shared';
import { connectSocket } from './socket';
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
  /** docs/RECEIPTS.md §5.3 — removes the failed bubble and resends its
   *  original args as a brand-new optimistic send (fresh reqId). No-op if
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
}

const Ctx = createContext<RealtimeCtx>({
  connected: false,
  sendMessage: () => {},
  retrySend: () => {},
  discardFailed: () => {},
  notePendingReaction: () => {},
  clearPendingReaction: () => {},
});

export function useRealtime(): RealtimeCtx {
  return useContext(Ctx);
}

export type MessagesCache = InfiniteData<MessagesResponse, string | null>;

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

/** Sort key for reinserting restored messages: numeric id descending
 *  (newest first, matching the server's keyset page order), with any local
 *  (`pending:`/`failed:`) bubble — not yet a real BigInt id — pinned above
 *  everything else rather than fed to `BigInt()`. */
function byIdDesc(a: Message, b: Message): number {
  const aLocal = isLocalId(a.id);
  const bLocal = isLocalId(b.id);
  if (aLocal || bLocal) return aLocal && bLocal ? 0 : aLocal ? -1 : 1;
  const an = BigInt(a.id);
  const bn = BigInt(b.id);
  return an === bn ? 0 : an > bn ? -1 : 1;
}

/** Args needed to (re)send a text message — captured at `sendMessage` time
 *  and kept in `failedRef` (keyed by reqId) so `retrySend` can replay them
 *  without the caller re-supplying anything (docs/RECEIPTS.md §5.3). */
interface PendingSendArgs {
  chatId: string;
  body: string;
  replyToId?: string;
  replyPreview?: ReplyPreview;
}

function buildOptimisticMessage(id: string, args: PendingSendArgs, senderId: string): Message {
  return {
    id,
    chatId: args.chatId,
    senderId,
    kind: 'text',
    body: args.body,
    createdAt: new Date().toISOString(),
    media: null,
    replyTo: args.replyPreview ?? null,
    reactions: [],
    editedAt: null,
  };
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
  // (echo arrives, or the server sends `error`).
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

  /** Fire-and-forget delivery ack (docs/RECEIPTS.md §4.2/§5.2) — a hint, not
   *  a request: no reply is expected, and a disconnected socket just drops
   *  it (the next reconnect's batch-ack above covers the gap). */
  function sendDeliveredAck(items: { chatId: string; messageId: string }[]): void {
    const socket = socketRef.current;
    if (!socket?.connected || items.length === 0) return;
    socket.emit('ws', makeEnvelope(WsType.DeliveredAck, { items }));
  }

  /** Clears a send's 10s failure-timeout once it resolves some other way
   *  (echo arrived, server errored) — see `sendMessage`'s own timeout below. */
  function clearSendTimeout(reqId: string): void {
    const t = sendTimeoutsRef.current.get(reqId);
    if (t !== undefined) {
      window.clearTimeout(t);
      sendTimeoutsRef.current.delete(reqId);
    }
  }

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
      // Server is truth (hard invariant 3): a reconnect refetches receipts
      // rather than trusting whatever WS frames were missed while offline.
      void qc.invalidateQueries({ queryKey: ['receipts'] });
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('ws', (frame: WsEnvelope) => {
      switch (frame.type) {
        case WsType.MessageNew: {
          const { message } = frame.payload as MessageNewPayload;
          const pending = frame.reqId ? pendingRef.current.get(frame.reqId) : undefined;

          qc.setQueryData<MessagesCache>(['messages', message.chatId], (old) =>
            withFirstPage(old, (messages) => {
              if (pending) return messages.map((m) => (m.id === pending.tempId ? message : m));
              if (messages.some((m) => m.id === message.id)) return messages;
              return [message, ...messages];
            }),
          );
          if (pending && frame.reqId) {
            pendingRef.current.delete(frame.reqId);
            failedRef.current.delete(frame.reqId);
            clearSendTimeout(frame.reqId);
          }
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
          qc.setQueryData<MessagesCache>(['messages', message.chatId], (old) =>
            withFirstPage(old, (messages) => messages.map((m) => (m.id === message.id ? message : m))),
          );
          void qc.invalidateQueries({ queryKey: ['chats'] });
          sendDeliveredAck([{ chatId: message.chatId, messageId: message.id }]);
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
          qc.setQueryData<MessagesCache>(['messages', chatId], (old) =>
            withFirstPage(old, (messages) => {
              const byId = new Map(messages.map((m) => [m.id, m]));
              for (const m of restored) byId.set(m.id, m);
              return Array.from(byId.values()).sort(byIdDesc);
            }),
          );
          void qc.invalidateQueries({ queryKey: ['chats'] });
          break;
        }
        case WsType.FriendRequest:
        case WsType.FriendAccepted:
          void qc.invalidateQueries({ queryKey: ['friends'] });
          break;
        case WsType.TagAdded:
        case WsType.TagRemoved:
          // Payloads only carry mediaId, not chatId — invalidating broadly
          // is cheap (react-query only refetches queries currently mounted)
          // and keeps every open gallery/viewer in sync with shared-wiki tags.
          void qc.invalidateQueries({ queryKey: ['gallery'] });
          void qc.invalidateQueries({ queryKey: ['mediaTags'] });
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

    const socket = socketRef.current;
    const me = qc.getQueryData<MeResponse | null>(['me']);
    const reqId = crypto.randomUUID();
    const args: PendingSendArgs = { chatId, body: trimmed, replyToId, replyPreview };

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
    socket.emit('ws', makeEnvelope(WsType.MessageSend, { chatId, body: trimmed, ...(replyToId ? { replyToId } : {}) }, reqId));

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
    failedRef.current.delete(reqId);
    qc.setQueryData<MessagesCache>(['messages', args.chatId], (old) =>
      withFirstPage(old, (messages) => messages.filter((m) => m.id !== failedId)),
    );
    sendMessage(args.chatId, args.body, args.replyToId, args.replyPreview);
  }

  function discardFailed(failedId: string): void {
    if (!isFailedId(failedId)) return;
    const reqId = failedId.slice('failed:'.length);
    const args = failedRef.current.get(reqId);
    failedRef.current.delete(reqId);
    if (!args) return;
    qc.setQueryData<MessagesCache>(['messages', args.chatId], (old) =>
      withFirstPage(old, (messages) => messages.filter((m) => m.id !== failedId)),
    );
  }

  return (
    <Ctx.Provider value={{ connected, sendMessage, retrySend, discardFailed, notePendingReaction, clearPendingReaction }}>
      {children}
    </Ctx.Provider>
  );
}
