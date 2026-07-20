import { useState } from 'react';
import type { ChatSummary, GalleryAlbum, MeResponse } from '@den/shared';
import { useMe } from './hooks/useMe';
import { AuthScreen } from './components/AuthScreen';
import { Profile } from './components/Profile';
import { InstallInstructions } from './components/InstallInstructions';
import { PushPoc } from './components/PushPoc';
import { VoicePoc } from './components/VoicePoc';
import { WsProbe } from './components/WsProbe';
import { RealtimeProvider } from './lib/realtime';
import { ChatList } from './components/ChatList';
import { ChatView } from './components/ChatView';
import { FriendsScreen } from './components/FriendsScreen';
import { NewGroupScreen } from './components/NewGroupScreen';
import { GalleryScreen } from './components/GalleryScreen';
import { ChatGallery } from './components/ChatGallery';
import { createChat, fetchChats } from './lib/chats';
import { useQueryClient } from '@tanstack/react-query';

/**
 * App shell + auth gate. Server is the source of truth: we render off the
 * /me query, never off local state (hard invariant 3). Chat features (Stage
 * 2-4) sit behind a small hand-rolled view stack — no router dependency
 * needed for this.
 */
export default function App() {
  const { data: me, isLoading } = useMe();

  if (isLoading) {
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-neutral-50 text-neutral-400 dark:bg-neutral-950">
        <span className="animate-pulse text-sm">Loading…</span>
      </div>
    );
  }

  if (!me) return <AuthScreen />;

  return (
    <RealtimeProvider>
      <AuthedApp me={me} />
    </RealtimeProvider>
  );
}

type View =
  | { name: 'chats' }
  | { name: 'chat'; chat: ChatSummary; jumpToMessageId?: string }
  | { name: 'friends' }
  | { name: 'newGroup' }
  | { name: 'profile' }
  | { name: 'gallery' }
  | { name: 'chatGallery'; album: GalleryAlbum };

function AuthedApp({ me }: { me: MeResponse }) {
  const [view, setView] = useState<View>({ name: 'chats' });
  const qc = useQueryClient();

  async function openDmWith(userId: string): Promise<void> {
    const chat = await createChat({ memberIds: [userId] });
    void qc.invalidateQueries({ queryKey: ['chats'] });
    setView({ name: 'chat', chat });
  }

  /** Gallery only has chatId/messageId (GalleryItem doesn't carry a full
   *  ChatSummary) — look the chat up from the already-fetched list, falling
   *  back to a refetch for the rare case it isn't cached yet. */
  async function jumpToMessage(chatId: string, messageId: string): Promise<void> {
    let chats = qc.getQueryData<{ chats: ChatSummary[] }>(['chats'])?.chats;
    let chat = chats?.find((c) => c.id === chatId);
    if (!chat) {
      chats = (await fetchChats()).chats;
      qc.setQueryData(['chats'], { chats });
      chat = chats.find((c) => c.id === chatId);
    }
    if (chat) setView({ name: 'chat', chat, jumpToMessageId: messageId });
  }

  if (view.name === 'friends') {
    return (
      <FriendsScreen
        onBack={() => setView({ name: 'chats' })}
        onMessage={(userId) => void openDmWith(userId)}
      />
    );
  }

  if (view.name === 'newGroup') {
    return (
      <NewGroupScreen
        onBack={() => setView({ name: 'chats' })}
        onCreated={(chat) => setView({ name: 'chat', chat })}
      />
    );
  }

  if (view.name === 'chat') {
    return (
      <ChatView
        chat={view.chat}
        me={me}
        onBack={() => setView({ name: 'chats' })}
        onOpenGallery={() =>
          setView({
            name: 'chatGallery',
            album: { chatId: view.chat.id, name: view.chat.name, isGroup: view.chat.isGroup, members: view.chat.members, coverThumbUrl: null, mediaCount: 0 },
          })
        }
        jumpToMessageId={view.jumpToMessageId}
      />
    );
  }

  if (view.name === 'chatGallery') {
    return (
      <ChatGallery
        album={view.album}
        me={me}
        onBack={() => setView({ name: 'gallery' })}
        onJumpToMessage={(chatId, messageId) => void jumpToMessage(chatId, messageId)}
      />
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="flex-1 overflow-y-auto">
        {view.name === 'profile' ? (
          <ProfileTab me={me} />
        ) : view.name === 'gallery' ? (
          <GalleryScreen me={me} onOpenAlbum={(album) => setView({ name: 'chatGallery', album })} />
        ) : (
          <ChatList
            me={me}
            onOpenChat={(chat) => setView({ name: 'chat', chat })}
            onFriends={() => setView({ name: 'friends' })}
            onNewGroup={() => setView({ name: 'newGroup' })}
          />
        )}
      </div>

      <nav
        className="flex border-t border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <TabButton label="Chats" active={view.name === 'chats'} onClick={() => setView({ name: 'chats' })} />
        <TabButton label="Gallery" active={view.name === 'gallery'} onClick={() => setView({ name: 'gallery' })} />
        <TabButton label="Profile" active={view.name === 'profile'} onClick={() => setView({ name: 'profile' })} />
      </nav>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
      className={
        'flex-1 py-3 text-sm font-medium ' +
        (active ? 'text-indigo-600 dark:text-indigo-400' : 'text-neutral-400')
      }
    >
      {label}
    </button>
  );
}

function ProfileTab({ me }: { me: MeResponse }) {
  return (
    <div
      className="mx-auto flex max-w-lg flex-col gap-4 px-4 pb-4 pt-4"
      style={{
        paddingLeft: 'max(env(safe-area-inset-left), 1rem)',
        paddingRight: 'max(env(safe-area-inset-right), 1rem)',
      }}
    >
      <InstallInstructions />
      <Profile me={me} />
      <DebugTools />
    </div>
  );
}

/** Collapsible home for the Stage 0 PoCs — handy for real-device testing
 *  (CLAUDE.md: "keeping debugging easy for future testing"). */
function DebugTools() {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-2xl border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold"
      >
        Debug tools
        <span className="text-neutral-400">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-4 border-t border-black/10 p-4 dark:border-white/10">
          <PushPoc />
          <VoicePoc />
          <WsProbe />
        </div>
      )}
    </section>
  );
}
