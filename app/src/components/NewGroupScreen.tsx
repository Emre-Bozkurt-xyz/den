import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChatLimits, type ChatSummary } from '@den/shared';
import { Loader2, Users } from 'lucide-react';
import { useFriends } from '../hooks/useFriends';
import { createChat } from '../lib/chats';
import { ApiFetchError } from '../lib/api';
import { ScreenHeader } from './ScreenHeader';

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
    <div className="flex h-full flex-col">
      <ScreenHeader title="New group" onBack={onBack} />

      <div className="flex-1 overflow-y-auto px-4 pb-10">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Group name (optional)"
          maxLength={ChatLimits.nameMax}
          className="mt-4 w-full rounded-md border border-border bg-surface-raised px-3 py-2.5 text-base outline-none focus:border-accent"
        />

        <h2 className="mb-2 mt-6 px-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
          Add friends
        </h2>
        {data && data.friends.length === 0 && (
          <p className="px-1 text-sm text-text-muted">You need at least one friend to start a group.</p>
        )}
        <div className="flex flex-col gap-2">
          {data?.friends.map((e) => (
            <label
              key={e.user.id}
              className="flex items-center gap-3 rounded-md border border-border p-3 transition-colors hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={selected.has(e.user.id)}
                onChange={() => toggle(e.user.id)}
                className="h-4 w-4 accent-accent"
              />
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-accent text-sm font-bold text-white">
                {e.user.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{e.user.displayName}</p>
                <p className="truncate text-xs text-text-secondary">@{e.user.username}</p>
              </div>
            </label>
          ))}
        </div>

        {message && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{message}</p>}

        <button
          onClick={() => create.mutate()}
          disabled={selected.size < 2 || create.isPending}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
        >
          {create.isPending ? <Loader2 size={16} className="animate-spin" /> : <Users size={16} />}
          {create.isPending ? 'Creating…' : `Create group (${selected.size} selected)`}
        </button>
        {selected.size === 1 && (
          <p className="mt-2 text-center text-xs text-text-muted">
            Pick 2+ friends for a group — for one, message them directly instead.
          </p>
        )}
      </div>
    </div>
  );
}
