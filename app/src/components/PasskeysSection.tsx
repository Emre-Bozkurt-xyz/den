/**
 * Settings → Passkeys (docs/PASSKEYS.md §8).
 *
 * Lists this account's registered credentials and enrols new ones. One row per
 * device is the designed state, not a workaround — synced platform passkeys
 * cover most second devices for free, and cross-device (QR) sign-in registers
 * a local one on the machine that used it.
 *
 * ⚠️ "Add a passkey" calls the ceremony straight out of `onClick`. Do not put
 * a confirmation dialog, an await, or a state round-trip in front of it: iOS
 * requires the ceremony to start inside the user-gesture chain, and breaking
 * that fails cryptically rather than clearly (PROJECT.md §12).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Loader2, Pencil, Trash2 } from 'lucide-react';
import { ApiFetchError } from '../lib/api';
import {
  PasskeyCancelled,
  addPasskey,
  listPasskeys,
  passkeysSupported,
  removePasskey,
  renamePasskey,
} from '../lib/passkeys';

const QUERY_KEY = ['passkeys'];

export function PasskeysSection() {
  const qc = useQueryClient();
  const [supported] = useState(passkeysSupported);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  const list = useQuery({ queryKey: QUERY_KEY, queryFn: listPasskeys, enabled: supported });

  const add = useMutation({
    mutationFn: () => addPasskey(),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const rename = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) => renamePasskey(id, label),
    onSuccess: () => {
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => removePasskey(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  if (!supported) {
    return (
      <section className="rounded-lg border border-border bg-surface-raised p-4">
        <h3 className="text-sm font-semibold text-text-primary">Passkeys</h3>
        <p className="mt-2 text-xs text-text-secondary">
          This browser doesn&apos;t support passkeys. You can still sign in with your password.
        </p>
      </section>
    );
  }

  const credentials = list.data?.credentials ?? [];
  // A cancelled ceremony isn't an error — the user closed a sheet they opened.
  const addError =
    add.error instanceof PasskeyCancelled
      ? null
      : add.error instanceof ApiFetchError
        ? add.error.message
        : add.error
          ? 'Could not add that passkey — try again.'
          : null;
  const removeError =
    remove.error instanceof ApiFetchError
      ? remove.error.message
      : remove.error
        ? 'Could not remove that passkey — try again.'
        : null;

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-sm font-semibold text-text-primary">Passkeys</h3>
      <p className="mt-2 text-xs text-text-secondary">
        Sign in with your fingerprint, face or device PIN instead of typing a password. Nothing
        guessable ever leaves your device.
      </p>

      {list.isPending && (
        <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </p>
      )}

      {credentials.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {credentials.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-md bg-surface-sunken px-3 py-2"
            >
              <Fingerprint size={16} className="shrink-0 text-text-secondary" />

              {renaming === c.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const label = draftLabel.trim();
                    if (label) rename.mutate({ id: c.id, label });
                  }}
                >
                  <input
                    autoFocus
                    value={draftLabel}
                    onChange={(e) => setDraftLabel(e.target.value)}
                    className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 text-sm text-text-primary"
                  />
                  <button
                    type="submit"
                    disabled={rename.isPending}
                    className="text-xs font-semibold text-indigo-600 disabled:opacity-40 dark:text-indigo-400"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenaming(null)}
                    className="text-xs text-text-secondary"
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-text-primary">{c.label}</p>
                    <p className="text-xs text-text-secondary">
                      Added {new Date(c.createdAt).toLocaleDateString()}
                      {c.lastUsedAt
                        ? ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}`
                        : ' · never used'}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Rename ${c.label}`}
                    onClick={() => {
                      setRenaming(c.id);
                      setDraftLabel(c.label);
                    }}
                    className="shrink-0 p-1 text-text-secondary hover:text-text-primary"
                    style={{ touchAction: 'manipulation' }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${c.label}`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                    className="shrink-0 p-1 text-text-secondary hover:text-red-600 disabled:opacity-40 dark:hover:text-red-400"
                    style={{ touchAction: 'manipulation' }}
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {list.isSuccess && credentials.length === 0 && (
        <p className="mt-3 text-sm text-text-secondary">No passkeys yet.</p>
      )}

      <button
        type="button"
        disabled={add.isPending}
        onClick={() => add.mutate()}
        className="mt-3 flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40"
        style={{ touchAction: 'manipulation' }}
      >
        {add.isPending ? <Loader2 size={16} className="animate-spin" /> : <Fingerprint size={16} />}
        Add a passkey
      </button>

      {addError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{addError}</p>}
      {removeError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{removeError}</p>}

      {/* The ≥1-login-method rule is enforced server-side; saying so up front
          beats letting someone tap remove and get refused. */}
      {list.data && !list.data.hasPassword && credentials.length === 1 && (
        <p className="mt-2 text-xs text-text-secondary">
          This is your only way to sign in, so it can&apos;t be removed.
        </p>
      )}
    </section>
  );
}
