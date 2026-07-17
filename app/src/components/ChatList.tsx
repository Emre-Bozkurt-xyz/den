import type { ChatSummary, MeResponse, Message } from '@den/shared';
import { useChats } from '../hooks/useChats';
import { chatDisplayName } from '../lib/chats';

export function ChatList({
  me,
  onOpenChat,
  onFriends,
  onNewGroup,
}: {
  me: MeResponse;
  onOpenChat: (chat: ChatSummary) => void;
  onFriends: () => void;
  onNewGroup: () => void;
}) {
  const { data, isLoading } = useChats();

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header
        className="flex items-center justify-between gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <h1 className="text-2xl font-bold tracking-tight">Den</h1>
        <div className="flex gap-2">
          <button
            onClick={onNewGroup}
            className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium dark:border-white/15"
          >
            New group
          </button>
          <button onClick={onFriends} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white">
            Friends
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-neutral-400">Loading…</p>}
        {data && data.chats.length === 0 && (
          <div className="p-6 text-center text-sm text-neutral-400">
            No chats yet. Add a friend, then tap Message to start one.
          </div>
        )}
        {data?.chats.map((chat) => {
          const name = chatDisplayName(chat, me.id);
          return (
            <button
              key={chat.id}
              onClick={() => onOpenChat(chat)}
              className="flex w-full items-center gap-3 border-b border-black/5 px-4 py-3 text-left hover:bg-black/5 dark:border-white/5 dark:hover:bg-white/5"
            >
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-indigo-600 text-lg font-bold text-white">
                {name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-semibold">{name}</p>
                  {chat.lastMessage && (
                    <span className="shrink-0 text-xs text-neutral-400">{formatTime(chat.lastMessage.createdAt)}</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">
                    {chat.lastMessage ? previewFor(chat.lastMessage, me.id) : 'No messages yet'}
                  </p>
                  {chat.unreadCount > 0 && (
                    <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-indigo-600 px-1.5 text-xs font-semibold text-white">
                      {chat.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function previewFor(message: Message, meId: string): string {
  const prefix = message.senderId === meId ? 'You: ' : '';
  return `${prefix}${message.body ?? ''}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
