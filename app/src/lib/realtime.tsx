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
  type MessageNewPayload,
  type MessageRestoredPayload,
  type MessagesResponse,
  type MeResponse,
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
}

const Ctx = createContext<RealtimeCtx>({ connected: false, sendMessage: () => {} });

export function useRealtime(): RealtimeCtx {
  return useContext(Ctx);
}

type MessagesCache = InfiniteData<MessagesResponse, string | null>;

function withFirstPage(cache: MessagesCache | undefined, update: (messages: Message[]) => Message[]): MessagesCache | undefined {
  if (!cache || cache.pages.length === 0) return cache;
  const pages = cache.pages.slice();
  const first = pages[0]!;
  pages[0] = { ...first, messages: update(first.messages) };
  return { ...cache, pages };
}

/** Like `withFirstPage`, but applies across every page — a bulk delete can
 *  span a page boundary, so removing ids has to check the whole cache, not
 *  just the newest page (docs/MESSAGE_DELETE.md §4). */
function withAllPages(cache: MessagesCache | undefined, update: (messages: Message[]) => Message[]): MessagesCache | undefined {
  if (!cache) return cache;
  return { ...cache, pages: cache.pages.map((p) => ({ ...p, messages: update(p.messages) })) };
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
          // unread count — not optional (docs/MESSAGE_DELETE.md §3).
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
        default:
          break;
      }
    });

    return () => {
      socket.close();
      socketRef.current = null;
      pendingRef.current.clear();
    };
  }, [qc]);

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
    };

    pendingRef.current.set(reqId, { chatId, tempId });
    qc.setQueryData<MessagesCache>(['messages', chatId], (old) => withFirstPage(old, (messages) => [optimistic, ...messages]));
    socket.emit('ws', makeEnvelope(WsType.MessageSend, { chatId, body: trimmed, ...(replyToId ? { replyToId } : {}) }, reqId));
  }

  return <Ctx.Provider value={{ connected, sendMessage }}>{children}</Ctx.Provider>;
}
