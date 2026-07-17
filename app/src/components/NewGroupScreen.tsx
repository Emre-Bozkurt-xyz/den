import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChatLimits, type ChatSummary } from '@den/shared';
import { useFriends } from '../hooks/useFriends';
import { createChat } from '../lib/chats';
import { ApiFetchError } from '../lib/api';

/** Group creation (BACKBONE §2 item 4): pick 2+ friends, name it, go. Only
 *  accepted friends are selectable — friendship gates group adds. */
export function NewGroupScreen({ onCreated, onBack }: { onCreated: (chat: ChatSummary) => void; onBack: () => void }) {
  const { data } = useFriends();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => createChat({ memberIds: [...selected], name: name.trim() || undefined }),
    onSuccess: (chat) => {
      void qc.invalidateQueries({ queryKey: ['chats'] });
      onCreated(chat);
    },
  });

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const err = create.error;
  const message = err instanceof ApiFetchError ? err.message : err instanceof Error ? err.message : null;

  return (
    <div className="flex min-h-[100dvh] flex-col">
      <header
        className="flex items-center gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10"
        style={{ paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)' }}
      >
        <button onClick={onBack} className="text-sm text-indigo-600 dark:text-indigo-400" aria-label="Back">
          ← Back
        </button>
        <h1 className="text-lg font-semibold">New group</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-10">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Group name (optional)"
          maxLength={ChatLimits.nameMax}
          className="mt-4 w-full rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base outline-none focus:border-indigo-500 dark:border-white/15 dark:bg-neutral-900"
        />

        <h2 className="mb-2 mt-6 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Add friends
        </h2>
        {data && data.friends.length === 0 && (
          <p className="px-1 text-sm text-neutral-400">You need at least one friend to start a group.</p>
        )}
        <div className="flex flex-col gap-2">
          {data?.friends.map((e) => (
            <label
              key={e.user.id}
              className="flex items-center gap-3 rounded-xl border border-black/10 p-3 dark:border-white/10"
            >
              <input
                type="checkbox"
                checked={selected.has(e.user.id)}
                onChange={() => toggle(e.user.id)}
                className="h-4 w-4"
              />
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-indigo-600 text-sm font-bold text-white">
                {e.user.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{e.user.displayName}</p>
                <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">@{e.user.username}</p>
              </div>
            </label>
          ))}
        </div>

        {message && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{message}</p>}

        <button
          onClick={() => create.mutate()}
          disabled={selected.size < 2 || create.isPending}
          className="mt-6 w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          {create.isPending ? '…' : `Create group (${selected.size} selected)`}
        </button>
        {selected.size === 1 && (
          <p className="mt-2 text-center text-xs text-neutral-400">
            Pick 2+ friends for a group — for one, message them directly instead.
          </p>
        )}
      </div>
    </div>
  );
}
