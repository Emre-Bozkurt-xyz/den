import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@den/shared';
import { LogOut, Save } from 'lucide-react';
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
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-pill bg-accent text-lg font-bold text-white">
          {me.displayName.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold text-text-primary">{me.displayName}</p>
          <p className="truncate text-sm text-text-secondary">@{me.username}</p>
        </div>
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="text-xs font-medium text-text-secondary">Display name</span>
        <input
          className="rounded-md border border-border bg-surface px-3 py-2 text-base outline-none focus:border-accent"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
        >
          <Save size={15} />
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40 dark:text-red-400"
        >
          <LogOut size={15} />
          Log out
        </button>
      </div>
      {save.isError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Could not save — try again.</p>
      )}
    </section>
  );
}
