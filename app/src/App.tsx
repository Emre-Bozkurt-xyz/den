import { useEffect, useRef, useState } from 'react';
import type { ChatSummary, GalleryAlbum, MeResponse } from '@den/shared';
import { Images, MessageCircle, User } from 'lucide-react';
import { useMe } from './hooks/useMe';
import { useIsMobile } from './hooks/useIsMobile';
import { INITIAL_SEARCH_STATE, type SearchFormState } from './hooks/useMessageSearch';
import { BackStackProvider, useBackHandler } from './lib/backStack';
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
      <BackStackProvider>
        <AuthedApp me={me} />
      </BackStackProvider>
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

type ChatView_ = Extract<View, { name: 'chat' }>;
type Tab = 'chats' | 'gallery' | 'profile';

/** Which bottom-tab/icon-rail destination a given view "belongs to" — used
 *  only for tab-active highlighting, not for content branching (content
 *  branches on `view.name` directly). `chatGallery` counts as the gallery
 *  tab because that's where its own back button returns to, regardless of
 *  whether it was opened from the Gallery tab or from an open chat. */
function tabOf(view: View): Tab {
  if (view.name === 'profile') return 'profile';
  if (view.name === 'gallery' || view.name === 'chatGallery') return 'gallery';
  return 'chats';
}

/** Where the system back gesture should land from a given view — mirrors each
 *  screen's own in-app back-button target so the hardware/gesture back and the
 *  on-screen back arrow stay in lockstep. Chats is the true root (`null` → the
 *  back-stack's base guard makes back there an in-app no-op, never a blank
 *  page); Gallery/Profile fall back to Chats so only the home tab is inert.
 *  Pure and module-level so its reference is stable across renders. */
function parentOf(view: View): View | null {
  switch (view.name) {
    case 'chat':
    case 'friends':
    case 'newGroup':
    case 'gallery':
    case 'profile':
      return { name: 'chats' };
    case 'chatGallery':
      return { name: 'gallery' };
    case 'chats':
      return null;
  }
}

function AuthedApp({ me }: { me: MeResponse }) {
  const isMobile = useIsMobile();
  const [view, setView] = useState<View>({ name: 'chats' });
  // Desktop-only: remembers the chat that was open in the right pane so
  // opening the Friends/NewGroup overlay (which changes `view.name`) doesn't
  // lose it — the overlay renders on top of the still-mounted dual pane
  // rather than replacing it (docs/archive/UI_REVAMP.md §4.2). `view` stays the
  // single source of truth for "what's active on top"; this is purely a
  // rendering cache for "what's behind it", not a competing nav state.
  const [lastChatView, setLastChatView] = useState<ChatView_ | null>(null);
  // Per-chat draft-text cache, keyed by chat.id. Exists so `ChatView`'s draft
  // survives being remounted for a reason other than "the user switched to a
  // different chat" — specifically, crossing the mobile/desktop breakpoint
  // mid-session, which flips `AuthedApp` between two structurally different
  // JSX trees (see the mobile/desktop branches below) and forces React to
  // unmount+remount whichever `ChatView` instance was open. A plain `useRef`
  // (not `useState`) is deliberate: writes happen on every keystroke and
  // must not trigger an `AuthedApp` re-render — `ChatView` already owns its
  // own render via its local `draft` state, this cache only needs to be
  // readable at the moment a fresh `ChatView` instance mounts. See
  // docs/archive/UI_REVAMP.md §8.
  const draftCacheRef = useRef(new Map<string, string>());
  // Same pattern, same reason, for the search panel's per-chat state
  // (query text, filters, open/closed) — docs/MESSAGE_SEARCH.md §4.1.
  const searchStateCacheRef = useRef(new Map<string, SearchFormState>());
  // docs/EMBEDS.md §4.4 — Android Web Share Target lands here as a plain GET
  // navigation to `/share-target?url=&text=&title=` (vite.config.ts's
  // `share_target` manifest entry). Consumed once, on mount: extract the
  // shared text, wipe the URL back to `/` (so a refresh doesn't re-trigger
  // it), and hold it until the user picks a chat — the existing `ChatList`
  // IS the chat-picker the plan doc mentions, no new screen needed. iOS PWAs
  // can't be share targets at all (Apple limitation) — this path is
  // Android-only; copy-paste into the composer's paste-detect chip is the
  // iPhone fallback. ⚠️ Real-device: unverified on Android (share-sheet →
  // Den entry, and the manifest's GET share_target shape) — flag for the
  // checklist.
  const [pendingShare, setPendingShare] = useState<string | null>(null);
  useEffect(() => {
    if (window.location.pathname !== '/share-target') return;
    const params = new URLSearchParams(window.location.search);
    const shared = params.get('url') || params.get('text') || '';
    window.history.replaceState(null, '', '/');
    if (shared) setPendingShare(shared);
  }, []);
  const qc = useQueryClient();

  // Make the device back gesture / browser back button pop one level up the
  // view hierarchy instead of unwinding out of the PWA to a blank page. Open
  // overlays (MediaViewer, focus menu) register their own handlers and, being
  // registered later, intercept back first (LIFO).
  useBackHandler(parentOf(view) !== null, () => {
    const parent = parentOf(view);
    if (parent) setView(parent);
  });

  function openChat(chat: ChatSummary, jumpToMessageId?: string) {
    // docs/EMBEDS.md §4.4 — a pending share target lands as the prefilled
    // draft in whichever chat the user picks; the send itself still goes
    // through the normal composer submit (no auto-send — this is deliberate
    // "picking is sending" for MEDIA, but a shared link gets a chance to add
    // a caption first, same as pasting one).
    if (pendingShare) {
      const existing = draftCacheRef.current.get(chat.id) ?? '';
      draftCacheRef.current.set(chat.id, existing ? `${existing} ${pendingShare}` : pendingShare);
      setPendingShare(null);
    }
    const next: ChatView_ = { name: 'chat', chat, jumpToMessageId };
    setView(next);
    setLastChatView(next);
  }

  async function openDmWith(userId: string): Promise<void> {
    const chat = await createChat({ memberIds: [userId] });
    void qc.invalidateQueries({ queryKey: ['chats'] });
    openChat(chat);
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
    if (chat) openChat(chat, messageId);
  }

  function openGalleryFor(chat: ChatSummary) {
    setView({
      name: 'chatGallery',
      album: { chatId: chat.id, name: chat.name, isGroup: chat.isGroup, members: chat.members, coverThumbUrl: null, mediaCount: 0 },
    });
  }

  /** Closes the desktop Friends/NewGroup overlay back to whatever chat was
   *  open behind it (or the bare list if none was). Mobile never calls this
   *  — Friends/NewGroup's own `onBack` there always targets `{name:'chats'}`
   *  directly, matching today's behavior exactly. */
  function closeOverlay() {
    setView(lastChatView ?? { name: 'chats' });
  }

  if (isMobile) {
    let content;
    if (view.name === 'friends') {
      content = <FriendsScreen onBack={() => setView({ name: 'chats' })} onMessage={(userId) => void openDmWith(userId)} />;
    } else if (view.name === 'newGroup') {
      content = <NewGroupScreen onBack={() => setView({ name: 'chats' })} onCreated={(chat) => openChat(chat)} />;
    } else if (view.name === 'chat') {
      content = (
        <ChatView
          key={view.chat.id}
          chat={view.chat}
          me={me}
          onBack={() => setView({ name: 'chats' })}
          onOpenGallery={() => openGalleryFor(view.chat)}
          jumpToMessageId={view.jumpToMessageId}
          initialDraft={draftCacheRef.current.get(view.chat.id) ?? ''}
          onDraftChange={(draft) => draftCacheRef.current.set(view.chat.id, draft)}
          initialSearchState={searchStateCacheRef.current.get(view.chat.id) ?? INITIAL_SEARCH_STATE}
          onSearchStateChange={(state) => searchStateCacheRef.current.set(view.chat.id, state)}
        />
      );
    } else if (view.name === 'chatGallery') {
      content = (
        <ChatGallery
          album={view.album}
          me={me}
          onBack={() => setView({ name: 'gallery' })}
          onJumpToMessage={(chatId, messageId) => void jumpToMessage(chatId, messageId)}
        />
      );
    } else {
      content = (
        <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
          <div className="flex-1 overflow-y-auto">
            {view.name === 'profile' ? (
              <ProfileTab me={me} />
            ) : view.name === 'gallery' ? (
              <GalleryScreen me={me} onOpenAlbum={(album) => setView({ name: 'chatGallery', album })} />
            ) : (
              <div className="flex h-full flex-col">
                {pendingShare && <ShareTargetBanner />}
                <div className="min-h-0 flex-1">
                  <ChatList
                    me={me}
                    onOpenChat={(chat) => openChat(chat)}
                    onFriends={() => setView({ name: 'friends' })}
                    onNewGroup={() => setView({ name: 'newGroup' })}
                  />
                </div>
              </div>
            )}
          </div>
          <BottomNav view={view} setView={setView} />
        </div>
      );
    }

    // Single owner of the viewport-height slot — everything rendered inside
    // (list pane, chat pane, single-pane screens) fills it via h-full rather
    // than each re-declaring min-h-[100dvh] itself, which is what caused the
    // bottom nav to render ~44px below the fold (nested min-h-[100dvh]
    // containers stack their minimums instead of one filling the other).
    return <div className="h-[100dvh]">{content}</div>;
  }

  // --- Desktop: left icon rail + content area. Chats tab is dual-pane (list
  // pane always mounted + right pane driven by `view`); Gallery/Profile stay
  // single-pane (docs/archive/UI_REVAMP.md §4.2/§4.3). ---
  const tab = tabOf(view);
  const isChatsFamily = view.name === 'chats' || view.name === 'chat' || view.name === 'friends' || view.name === 'newGroup';
  const rightPaneChat: ChatView_ | null =
    view.name === 'chat' ? view : view.name === 'friends' || view.name === 'newGroup' ? lastChatView : null;
  const overlayName = view.name === 'friends' || view.name === 'newGroup' ? view.name : null;

  return (
    <div className="flex h-[100dvh] bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <IconRail
        active={tab}
        onChats={() => setView({ name: 'chats' })}
        onGallery={() => setView({ name: 'gallery' })}
        onProfile={() => setView({ name: 'profile' })}
      />

      <div className="h-full min-w-0 flex-1">
        {isChatsFamily ? (
          <div className="flex h-full">
            <div className="flex h-full w-[360px] shrink-0 flex-col border-r border-border">
              {pendingShare && <ShareTargetBanner />}
              <div className="min-h-0 flex-1">
                <ChatList
                  me={me}
                  onOpenChat={(chat) => openChat(chat)}
                  onFriends={() => setView({ name: 'friends' })}
                  onNewGroup={() => setView({ name: 'newGroup' })}
                />
              </div>
            </div>
            <div className="h-full min-w-0 flex-1">
              {rightPaneChat ? (
                <ChatView
                  key={rightPaneChat.chat.id}
                  chat={rightPaneChat.chat}
                  me={me}
                  onBack={() => setView({ name: 'chats' })}
                  onOpenGallery={() => openGalleryFor(rightPaneChat.chat)}
                  jumpToMessageId={rightPaneChat.jumpToMessageId}
                  initialDraft={draftCacheRef.current.get(rightPaneChat.chat.id) ?? ''}
                  onDraftChange={(draft) => draftCacheRef.current.set(rightPaneChat.chat.id, draft)}
                  initialSearchState={searchStateCacheRef.current.get(rightPaneChat.chat.id) ?? INITIAL_SEARCH_STATE}
                  onSearchStateChange={(state) => searchStateCacheRef.current.set(rightPaneChat.chat.id, state)}
                />
              ) : (
                <EmptyChatState />
              )}
            </div>
          </div>
        ) : view.name === 'profile' ? (
          <div className="h-full overflow-y-auto">
            <ProfileTab me={me} />
          </div>
        ) : view.name === 'gallery' ? (
          <div className="h-full overflow-y-auto">
            <GalleryScreen me={me} onOpenAlbum={(album) => setView({ name: 'chatGallery', album })} />
          </div>
        ) : (
          <ChatGallery
            album={view.album}
            me={me}
            onBack={() => setView({ name: 'gallery' })}
            onJumpToMessage={(chatId, messageId) => void jumpToMessage(chatId, messageId)}
          />
        )}
      </div>

      {overlayName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-surface-raised shadow-strong">
            {overlayName === 'friends' ? (
              <FriendsScreen onBack={closeOverlay} onMessage={(userId) => void openDmWith(userId)} />
            ) : (
              <NewGroupScreen onBack={closeOverlay} onCreated={(chat) => openChat(chat)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BottomNav({ view, setView }: { view: View; setView: (v: View) => void }) {
  return (
    <nav
      className="flex border-t border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900"
      // Feel-tuning: the full safe-area inset (~34px on a home-indicator
      // iPhone) stacks on top of the TabButton's own py-2.5, which read as
      // too tall — trim it back rather than dropping it (still clears the
      // home indicator). ⚠️ iPhone device-gate: re-check the stacked height
      // on a real home-indicator device.
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom) - 0.5rem, 0px)' }}
    >
      <TabButton label="Chats" active={view.name === 'chats'} onClick={() => setView({ name: 'chats' })} />
      <TabButton label="Gallery" active={view.name === 'gallery'} onClick={() => setView({ name: 'gallery' })} />
      <TabButton label="Profile" active={view.name === 'profile'} onClick={() => setView({ name: 'profile' })} />
    </nav>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
      className={
        'flex-1 py-2.5 text-sm font-medium ' +
        (active ? 'text-indigo-600 dark:text-indigo-400' : 'text-neutral-400')
      }
    >
      {label}
    </button>
  );
}

/** Desktop-only left rail replacing the bottom tab bar above the mobile
 *  breakpoint — same three destinations (Chats/Gallery/Profile). */
function IconRail({
  active,
  onChats,
  onGallery,
  onProfile,
}: {
  active: Tab;
  onChats: () => void;
  onGallery: () => void;
  onProfile: () => void;
}) {
  return (
    <nav
      className="flex h-full w-16 shrink-0 flex-col items-center gap-2 border-r border-border bg-surface-raised py-4"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 1rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1rem)',
      }}
    >
      <RailButton icon={MessageCircle} label="Chats" active={active === 'chats'} onClick={onChats} />
      <RailButton icon={Images} label="Gallery" active={active === 'gallery'} onClick={onGallery} />
      <RailButton icon={User} label="Profile" active={active === 'profile'} onClick={onProfile} />
    </nav>
  );
}

function RailButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof MessageCircle;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{ touchAction: 'manipulation' }}
      className={
        'grid place-items-center rounded-md p-3 ' +
        (active ? 'bg-accent text-white' : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/5')
      }
    >
      <Icon size={22} />
    </button>
  );
}

/** docs/EMBEDS.md §4.4 — sits above `ChatList` while a Web Share Target hand-
 *  off is pending a chat pick. `ChatList` itself is the picker; this is just
 *  the "why is a chat list open right now" hint. Plainly styled, matching
 *  the deliberate UI-polish-deferred posture elsewhere in Den. */
function ShareTargetBanner() {
  return (
    <p className="shrink-0 border-b border-border bg-accent/10 px-4 py-2 text-xs text-accent">
      Pick a chat to share this link
    </p>
  );
}

/** Desktop right-pane placeholder when the Chats tab has no chat selected
 *  (fresh load, or after deselecting via the icon rail / a chat's own back
 *  button). */
function EmptyChatState() {
  return (
    <div className="grid h-full place-items-center text-sm text-text-muted">
      Select a chat to start messaging
    </div>
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
    <section className="rounded-lg border border-black/10 bg-white dark:border-white/10 dark:bg-neutral-900">
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
