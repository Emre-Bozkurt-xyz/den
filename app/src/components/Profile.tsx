import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@den/shared';
import { logout, updateMe } from '../lib/auth';

/** Account card: shows the user, edits display name (settings stub), logs out.
 *  Avatar upload waits for R2 (Stage 3). */
export function Profile({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const [name, setName] = useState(me.displayName);

  const save = useMutation({
    mutationFn: () => updateMe({ displayName: name.trim() }),
    onSuccess: (user) => qc.setQueryData(['me'], user),
  });

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => qc.setQueryData(['me'], null),
  });

  const dirty = name.trim() !== me.displayName && name.trim().length > 0;

  return (
    <section className="rounded-2xl border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-indigo-600 text-lg font-bold text-white">
          {me.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold">{me.displayName}</p>
          <p className="truncate text-sm text-neutral-500 dark:text-neutral-400">@{me.username}</p>
        </div>
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Display name
        </span>
        <input
          className="rounded-xl border border-black/10 bg-white px-3 py-2 text-base outline-none focus:border-indigo-500 dark:border-white/15 dark:bg-neutral-950"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="rounded-xl border border-black/10 px-4 py-2 text-sm font-medium text-red-600 dark:border-white/15 dark:text-red-400"
        >
          Log out
        </button>
      </div>
      {save.isError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Could not save — try again.</p>
      )}
    </section>
  );
}
