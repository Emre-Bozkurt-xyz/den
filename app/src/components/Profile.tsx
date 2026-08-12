import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@den/shared';
import { Link2, Link2Off, Pencil, Save } from 'lucide-react';
import { updateMe } from '../lib/auth';
import { useVaultStatus } from '../hooks/useVaultStatus';
import { connectVault, unlinkVault } from '../lib/vault';

/** Identity card — the Profile tab's landing element (docs/MEDIA_ATTACHMENTS.md
 *  §5.6). The owner asked for this one card specifically to be styled a bit
 *  better than the rest of the (deliberately plain) app: a larger avatar,
 *  bigger display name, muted @username, display-name edit behind an Edit
 *  affordance instead of a permanently-open input. Still token-only — no
 *  gradients, no cover image, no new colors. Log out lives one level up
 *  (App.tsx's ProfileTab), since this card is specifically the "who am I"
 *  identity, not the whole landing page. Avatar upload waits for R2 (Stage 3). */
export function Profile({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.displayName);

  const save = useMutation({
    mutationFn: () => updateMe({ displayName: name.trim() }),
    onSuccess: (user) => {
      qc.setQueryData(['me'], user);
      setEditing(false);
    },
  });

  const dirty = name.trim() !== me.displayName && name.trim().length > 0;

  function startEdit() {
    setName(me.displayName);
    setEditing(true);
  }

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex items-center gap-4">
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-pill bg-accent text-2xl font-bold text-white">
          {me.displayName.charAt(0).toUpperCase()}
        </div>

        {editing ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <input
              autoFocus
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-base font-semibold text-text-primary outline-none focus:border-accent"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => save.mutate()}
                disabled={!dirty || save.isPending}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
              >
                <Save size={13} />
                {save.isPending ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-sunken"
              >
                Cancel
              </button>
            </div>
            {save.isError && (
              <p className="text-xs text-red-600 dark:text-red-400">Could not save — try again.</p>
            )}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold text-text-primary">{me.displayName}</p>
            <p className="truncate text-sm text-text-secondary">@{me.username}</p>
            <button
              onClick={startEdit}
              className="mt-1 flex items-center gap-1 text-xs font-medium text-accent"
              style={{ touchAction: 'manipulation' }}
            >
              <Pencil size={12} />
              Edit name
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** docs/EMBEDS.md §5.3 — "Connect Vault" section. Plainly styled (UI polish
 *  is deliberately deferred — [[feedback_ui_polish_deferred]]). `Connect` is
 *  a full-page navigation (see `lib/vault.ts`'s `connectVault` doc comment),
 *  not a mutation — there's no JSON response to react to, the browser just
 *  leaves and comes back. ⚠️ Unverified end-to-end: no live Vault instance
 *  is reachable from this environment (see the executor report). */
export function VaultLinkSection() {
  const qc = useQueryClient();
  const { data: status, isLoading } = useVaultStatus();

  const unlink = useMutation({
    mutationFn: unlinkVault,
    onSuccess: () => qc.setQueryData<{ linked: boolean; vaultDisplayName: string | null }>(['vaultStatus'], {
      linked: false,
      vaultDisplayName: null,
    }),
  });

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-sm font-semibold text-text-primary">Vault</h3>
      <p className="mt-1 text-xs text-text-secondary">
        Link your Vault account to reference and edit Vault documents from inside Den.
      </p>

      {isLoading ? (
        <p className="mt-3 text-sm text-text-muted">Loading…</p>
      ) : status?.linked ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm text-text-primary">
            <Link2 size={15} className="text-accent" />
            Connected{status.vaultDisplayName ? ` as ${status.vaultDisplayName}` : ''}
          </span>
          <button
            onClick={() => unlink.mutate()}
            disabled={unlink.isPending}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-sunken disabled:pointer-events-none disabled:opacity-40"
          >
            <Link2Off size={14} />
            Unlink
          </button>
        </div>
      ) : (
        <button
          onClick={connectVault}
          className="mt-3 flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <Link2 size={15} />
          Connect Vault
        </button>
      )}
      {unlink.isError && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">Could not unlink — try again.</p>
      )}
    </section>
  );
}
