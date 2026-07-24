import { Camera, Link as LinkIcon, Mic, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ChatSummary, EmbedProvider, MeResponse, Message } from '@den/shared';
import { useChats } from '../hooks/useChats';
import { chatDisplayName } from '../lib/chats';
import { ScreenHeader } from './ScreenHeader';

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
    <div className="flex h-full flex-col">
      <ScreenHeader
        title="Den"
        size="large"
        trailing={
          <>
            <button
              onClick={onNewGroup}
              className="rounded-sm border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
            >
              New group
            </button>
            <button
              onClick={onFriends}
              className="rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover active:bg-accent-hover"
            >
              Friends
            </button>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="p-4 text-sm text-text-muted">Loading…</p>}
        {data && data.chats.length === 0 && (
          <div className="p-6 text-center text-sm text-text-muted">
            No chats yet. Add a friend, then tap Message to start one.
          </div>
        )}
        {data?.chats.map((chat) => {
          const name = chatDisplayName(chat, me.id);
          return (
            <button
              key={chat.id}
              onClick={() => onOpenChat(chat)}
              className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
            >
              {/* Fixed avatar footprint (relative + ring) — a hook point for a
                  future online-state dot; no presence data exists yet, so
                  nothing renders there now (out of MVP scope). */}
              <div className="relative h-12 w-12 shrink-0">
                <div className="grid h-full w-full place-items-center rounded-pill bg-accent text-base font-semibold text-white ring-2 ring-surface">
                  {name.charAt(0).toUpperCase()}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate font-semibold text-text-primary">{name}</p>
                  {chat.lastMessage && (
                    <span className="shrink-0 text-xs text-text-muted">{formatTime(chat.lastMessage.createdAt)}</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm text-text-secondary">
                    {chat.lastMessage ? previewFor(chat.lastMessage, me.id) : 'No messages yet'}
                  </p>
                  {chat.unreadCount > 0 && (
                    <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-pill bg-accent px-1.5 text-xs font-semibold tabular-nums text-white">
                      {formatUnreadCount(chat.unreadCount)}
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

const MEDIA_ICON: Record<'image' | 'video' | 'voice', typeof Camera> = { image: Camera, video: Video, voice: Mic };
const MEDIA_LABEL: Record<'image' | 'video' | 'voice', string> = { image: 'Photo', video: 'Video', voice: 'Voice message' };

// docs/EMBEDS.md — same "media with no caption still needs a readable
// preview" rule as MEDIA_LABEL above.
const EMBED_LABEL: Record<EmbedProvider, string> = { instagram: 'Instagram reel', vault: 'Vault doc' };

function previewFor(message: Message, meId: string): ReactNode {
  const prefix = message.senderId === meId ? 'You: ' : '';
  const body = message.body?.trim();
  if (body) return `${prefix}${body}`;
  if (message.media) {
    const Icon = MEDIA_ICON[message.media.kind];
    return (
      <span className="inline-flex items-center gap-1">
        {prefix}
        <Icon size={13} className="shrink-0" />
        {MEDIA_LABEL[message.media.kind]}
      </span>
    );
  }
  if (message.embed) {
    return (
      <span className="inline-flex items-center gap-1">
        {prefix}
        <LinkIcon size={13} className="shrink-0" />
        {EMBED_LABEL[message.embed.provider]}
      </span>
    );
  }
  return prefix;
}

function formatUnreadCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
