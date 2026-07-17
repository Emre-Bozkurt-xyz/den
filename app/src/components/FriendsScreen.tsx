import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FriendEntry } from '@den/shared';
import { useFriends } from '../hooks/useFriends';
import { acceptFriendRequest, declineFriendRequest, sendFriendRequest } from '../lib/friends';
import { ApiFetchError } from '../lib/api';

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
    <div className="flex min-h-[100dvh] flex-col">
      <header
        className="flex items-center gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400" aria-label="Back">
          ← Back
        </button>
        <h1 className="text-lg font-semibold">Friends</h1>
      </header>

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
            className="min-w-0 flex-1 rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base outline-none focus:border-indigo-500 dark:border-white/15 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={send.isPending || !username.trim()}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
          >
            Add
          </button>
        </form>
        {sendMessage && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{sendMessage}</p>}

        {isLoading && <p className="mt-6 text-sm text-neutral-400">Loading…</p>}

        {data && data.incoming.length > 0 && (
          <Section title="Requests">
            {data.incoming.map((e) => (
              <div
                key={e.user.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-black/10 p-3 dark:border-white/10"
              >
                <Avatar entry={e} />
                <div className="flex gap-2">
                  <button
                    onClick={() => accept.mutate(e.user.id)}
                    disabled={accept.isPending}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => decline.mutate(e.user.id)}
                    disabled={decline.isPending}
                    className="rounded-lg border border-black/10 px-3 py-1.5 text-sm dark:border-white/15"
                  >
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
              <div key={e.user.id} className="flex items-center justify-between gap-3 rounded-xl p-3">
                <Avatar entry={e} />
                <span className="text-sm text-neutral-400">Pending…</span>
              </div>
            ))}
          </Section>
        )}

        <Section title="Friends">
          {data && data.friends.length === 0 && (
            <p className="px-1 text-sm text-neutral-400">No friends yet — add someone by username above.</p>
          )}
          {data?.friends.map((e) => (
            <button
              key={e.user.id}
              onClick={() => onMessage(e.user.id)}
              className="flex w-full items-center justify-between gap-3 rounded-xl p-3 text-left hover:bg-black/5 dark:hover:bg-white/5"
            >
              <Avatar entry={e} />
              <span className="text-sm font-medium text-indigo-600 dark:text-indigo-400">Message</span>
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
      <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">{title}</h2>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Avatar({ entry }: { entry: FriendEntry }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-600 text-sm font-bold text-white">
        {entry.user.displayName.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{entry.user.displayName}</p>
        <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">@{entry.user.username}</p>
      </div>
    </div>
  );
}
