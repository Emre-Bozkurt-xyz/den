import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { type InfiniteData, useQueryClient } from '@tanstack/react-query';
import {
  WsType,
  makeEnvelope,
  type WsEnvelope,
  type Message,
  type MediaReadyPayload,
  type MessageDeletedPayload,
  type MessageEditedPayload,
  type MessageNewPayload,
  type MessageRestoredPayload,
  type MessagesResponse,
  type MeResponse,
  type ReactionAddedPayload,
  type ReactionRemovedPayload,
  type ReactionSummary,
  type ReplyPreview,
} from '@den/shared';
import { connectSocket } from './socket';

interface RealtimeCtx {
  connected: boolean;
  /** Optimistic text send: inserts a pending bubble, emits message.send, and
   *  reconciles it (or rolls it back) when the server replies — matched by
   *  the envelope's `reqId` (BACKBONE §4). `replyToId`/`replyPreview`
   *  (post-MVP) are optional: when set, the WS payload carries `replyToId`
   *  and the optimistic bubble shows `replyPreview` immediately, ahead of the
   *  server's authoritative `message.new` reconciling it. */
  sendMessage: (chatId: string, body: string, replyToId?: string, replyPreview?: ReplyPreview) => void;
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
 *  (newest first, matching the server's keyset page order), with any
 *  still-pending optimistic bubble (`pending:<reqId>`, not yet a real
 *  BigInt id) pinned above everything else rather than fed to `BigInt()`. */
function byIdDesc(a: Message, b: Message): number {
  const aPending = a.id.startsWith('pending:');
  const bPending = b.id.startsWith('pending:');
  if (aPending || bPending) return aPending && bPending ? 0 : aPending ? -1 : 1;
  const an = BigInt(a.id);
  const bn = BigInt(b.id);
  return an === bn ? 0 : an > bn ? -1 : 1;
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
  const pendingRef = useRef(new Map<string, { chatId: string; tempId: string }>());
  // Post-MVP reactions: `reactionPendingKey`s this client just optimistically
  // applied itself and is waiting to see echoed back — see
  // `RealtimeCtx.notePendingReaction`'s doc comment for the double-count trap
  // this exists to avoid.
  const pendingReactionsRef = useRef(new Set<string>());

  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['messages'] });
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
          if (pending) pendingRef.current.delete(frame.reqId!);
          void qc.invalidateQueries({ queryKey: ['chats'] });
          break;
        }
        case WsType.Error: {
          const pending = frame.reqId ? pendingRef.current.get(frame.reqId) : undefined;
          if (pending) {
            qc.setQueryData<MessagesCache>(['messages', pending.chatId], (old) =>
              withFirstPage(old, (messages) => messages.filter((m) => m.id !== pending.tempId)),
            );
            pendingRef.current.delete(frame.reqId!);
          }
          break;
        }
        case WsType.MediaReady: {
          const { message } = frame.payload as MediaReadyPayload;
          qc.setQueryData<MessagesCache>(['messages', message.chatId], (old) =>
            withFirstPage(old, (messages) => messages.map((m) => (m.id === message.id ? message : m))),
          );
          void qc.invalidateQueries({ queryKey: ['chats'] });
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
    const socket = socketRef.current;
    const trimmed = body.trim();
    if (!socket || !trimmed) return;

    const me = qc.getQueryData<MeResponse | null>(['me']);
    const reqId = crypto.randomUUID();
    const tempId = `pending:${reqId}`;
    const optimistic: Message = {
      id: tempId,
      chatId,
      senderId: me?.id ?? '0',
      kind: 'text',
      body: trimmed,
      createdAt: new Date().toISOString(),
      media: null,
      replyTo: replyPreview ?? null,
      reactions: [],
      editedAt: null,
    };

    pendingRef.current.set(reqId, { chatId, tempId });
    qc.setQueryData<MessagesCache>(['messages', chatId], (old) => withFirstPage(old, (messages) => [optimistic, ...messages]));
    socket.emit('ws', makeEnvelope(WsType.MessageSend, { chatId, body: trimmed, ...(replyToId ? { replyToId } : {}) }, reqId));
  }

  return (
    <Ctx.Provider value={{ connected, sendMessage, notePendingReaction, clearPendingReaction }}>{children}</Ctx.Provider>
  );
}
