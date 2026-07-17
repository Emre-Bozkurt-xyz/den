import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatSummary, MeResponse } from '@den/shared';
import { flattenMessages, useMessages } from '../hooks/useMessages';
import { chatDisplayName, markRead } from '../lib/chats';
import { useRealtime } from '../lib/realtime';

export function ChatView({ chat, me, onBack }: { chat: ChatSummary; me: MeResponse; onBack: () => void }) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useMessages(chat.id);
  const { sendMessage } = useRealtime();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const name = chatDisplayName(chat, me.id);

  const messages = flattenMessages(data?.pages);
  const lastMessageId = messages[messages.length - 1]?.id;

  // Mark the newest message read once it's loaded/changes — cheap and matches
  // "open the chat = you've seen it" (BACKBONE §5 last_read_message_id).
  useEffect(() => {
    if (lastMessageId && !lastMessageId.startsWith('pending:')) {
      void markRead(chat.id, lastMessageId).then(() => qc.invalidateQueries({ queryKey: ['chats'] }));
    }
  }, [chat.id, lastMessageId, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.id, messages.length]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    sendMessage(chat.id, draft);
    setDraft('');
  }

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header
        className="flex items-center gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400" aria-label="Back">
          ← Back
        </button>
        <div className="min-w-0">
          <p className="truncate font-semibold">{name}</p>
          {chat.isGroup && <p className="truncate text-xs text-neutral-400">{chat.members.length} members</p>}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {hasNextPage && (
          <div className="mb-3 flex justify-center">
            <button
              onClick={() => void fetchNextPage()}
              disabled={isFetchingNextPage}
              className="rounded-lg border border-black/10 px-3 py-1 text-xs text-neutral-500 dark:border-white/15 dark:text-neutral-400"
            >
              {isFetchingNextPage ? 'Loading…' : 'Load older messages'}
            </button>
          </div>
        )}

        {isLoading && <p className="text-center text-sm text-neutral-400">Loading…</p>}
        {!isLoading && messages.length === 0 && (
          <p className="text-center text-sm text-neutral-400">Say hi 👋</p>
        )}

        <div className="flex flex-col gap-1.5">
          {messages.map((m) => {
            const mine = m.senderId === me.id;
            const pending = m.id.startsWith('pending:');
            return (
              <div key={m.id} className={'flex ' + (mine ? 'justify-end' : 'justify-start')}>
                <div
                  className={
                    'max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ' +
                    (mine
                      ? 'bg-indigo-600 text-white ' + (pending ? 'opacity-60' : '')
                      : 'bg-black/5 text-neutral-900 dark:bg-white/10 dark:text-neutral-100')
                  }
                >
                  {chat.isGroup && !mine && (
                    <p className="mb-0.5 text-xs font-semibold opacity-70">
                      {chat.members.find((mem) => mem.id === m.senderId)?.displayName ?? 'Unknown'}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                </div>
              </div>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={submit}
        className="flex items-end gap-2 border-t border-black/10 p-3 dark:border-white/10"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 0.75rem)' }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message"
          className="min-w-0 flex-1 rounded-xl border border-black/10 bg-white px-3.5 py-2.5 text-base outline-none focus:border-indigo-500 dark:border-white/15 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          style={{ touchAction: 'manipulation' }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
