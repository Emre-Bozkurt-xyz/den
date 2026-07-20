import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FriendEntry } from '@den/shared';
import { Check, Clock, MessageCircle, UserPlus, X } from 'lucide-react';
import { useFriends } from '../hooks/useFriends';
import { acceptFriendRequest, declineFriendRequest, sendFriendRequest } from '../lib/friends';
import { ApiFetchError } from '../lib/api';
import { ScreenHeader } from './ScreenHeader';

/** Friending (BACKBONE §2): add by username, accept/decline incoming
 *  requests, and start a DM with an existing friend. Reached from the chat
 *  list header — friendship gates DMs and group adds, so this is the front
 *  door to messaging someone new. */
export function FriendsScreen({ onMessage, onBack }: { onMessage: (userId: string) => void; onBack: () => void }) {
  const { data, isLoading } = useFriends();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');

  const invalidate = () => qc.invalidateQueries({ queryKey: ['friends'] });

  const send = useMutation({
    mutationFn: () => sendFriendRequest({ username: username.trim().toLowerCase() }),
    onSuccess: () => {
      setUsername('');
      void invalidate();
    },
  });

  const accept = useMutation({ mutationFn: acceptFriendRequest, onSuccess: invalidate });
  const decline = useMutation({ mutationFn: declineFriendRequest, onSuccess: invalidate });

  const sendErr = send.error;
  const sendMessage =
    sendErr instanceof ApiFetchError ? sendErr.message : sendErr instanceof Error ? sendErr.message : null;

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Friends" onBack={onBack} />

      <div className="flex-1 overflow-y-auto px-4 pb-10">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) send.mutate();
          }}
          className="mt-4 flex gap-2"
        >
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-base outline-none focus:border-accent"
          />
          <button
            type="submit"
            disabled={send.isPending || !username.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
          >
            <UserPlus size={16} />
            Add
          </button>
        </form>
        {sendMessage && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{sendMessage}</p>}

        {isLoading && <p className="mt-6 text-sm text-text-muted">Loading…</p>}

        {data && data.incoming.length > 0 && (
          <Section title="Requests">
            {data.incoming.map((e) => (
              <div
                key={e.user.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
              >
                <Avatar entry={e} />
                <div className="flex gap-2">
                  <button
                    onClick={() => accept.mutate(e.user.id)}
                    disabled={accept.isPending}
                    className="flex items-center gap-1 rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Check size={15} />
                    Accept
                  </button>
                  <button
                    onClick={() => decline.mutate(e.user.id)}
                    disabled={decline.isPending}
                    className="flex items-center gap-1 rounded-sm border border-border px-3 py-1.5 text-sm transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40"
                  >
                    <X size={15} />
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </Section>
        )}

        {data && data.outgoing.length > 0 && (
          <Section title="Sent">
            {data.outgoing.map((e) => (
              <div key={e.user.id} className="flex items-center justify-between gap-3 rounded-md p-3">
                <Avatar entry={e} />
                <span className="flex items-center gap-1 text-sm text-text-muted">
                  <Clock size={14} />
                  Pending…
                </span>
              </div>
            ))}
          </Section>
        )}

        <Section title="Friends">
          {data && data.friends.length === 0 && (
            <p className="px-1 text-sm text-text-muted">No friends yet — add someone by username above.</p>
          )}
          {data?.friends.map((e) => (
            <button
              key={e.user.id}
              onClick={() => onMessage(e.user.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md p-3 text-left transition-colors hover:bg-surface-sunken active:bg-surface-sunken"
            >
              <Avatar entry={e} />
              <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400">
                <MessageCircle size={15} />
                Message
              </span>
            </button>
          ))}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Avatar({ entry }: { entry: FriendEntry }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-accent text-sm font-bold text-white">
        {entry.user.displayName.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{entry.user.displayName}</p>
        <p className="truncate text-xs text-text-secondary">@{entry.user.username}</p>
      </div>
    </div>
  );
}
