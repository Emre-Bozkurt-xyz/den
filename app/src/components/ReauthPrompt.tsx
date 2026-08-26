/**
 * "Confirm it's you" prompt (docs/ADMIN_CONSOLE.md §6).
 *
 * Shown when a destructive admin action returns `reauth_required`. It re-runs
 * the SAME factor the user already has — a passkey tap, or their password —
 * and its value is recency, not strength: it shortens the window in which an
 * unattended signed-in browser can do something irreversible.
 *
 * ⚠️ Not MFA. Don't describe it as such in copy, and don't add a second factor
 * here on the assumption that's what it is.
 *
 * ⚠️ The passkey button calls the ceremony straight out of `onClick` — no
 * await, no confirmation step in front of it — because iOS requires the
 * gesture chain intact (PROJECT.md §12).
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Fingerprint, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { ApiFetchError } from '../lib/api';
import { reauthStatus, reauthWithPasskey, reauthWithPassword } from '../lib/admin';

export function ReauthPrompt({
  action,
  onConfirmed,
  onCancel,
}: {
  /** What the user is about to do, e.g. "disable @bob". Shown verbatim. */
  action: string;
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const status = useQuery({ queryKey: ['admin', 'reauth'], queryFn: reauthStatus });

  const byPasskey = useMutation({ mutationFn: reauthWithPasskey, onSuccess: onConfirmed });
  const byPassword = useMutation({
    mutationFn: () => reauthWithPassword(password),
    onSuccess: onConfirmed,
  });

  const err = byPasskey.error ?? byPassword.error;
  // A cancelled passkey sheet is the user changing their mind, not an error.
  const cancelled = (err as { name?: string })?.name === 'NotAllowedError' || (err as { name?: string })?.name === 'AbortError';
  const message = cancelled
    ? null
    : err instanceof ApiFetchError
      ? err.message
      : err
        ? 'Could not confirm — try again.'
        : null;
  const busy = byPasskey.isPending || byPassword.isPending;

  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <ShieldCheck size={15} /> Confirm it&apos;s you
      </h4>
      <p className="mt-1.5 text-xs text-text-secondary">
        Before {action}. Being signed in isn&apos;t enough for changes like this.
      </p>

      {status.isPending && (
        <p className="mt-3 flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </p>
      )}

      {status.isSuccess && (
        <div className="mt-3 flex flex-col gap-2">
          {status.data.canUsePasskey && (
            <button
              type="button"
              disabled={busy}
              onClick={() => byPasskey.mutate()}
              className="flex items-center justify-center gap-2 rounded-md border border-border px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-40"
              style={{ touchAction: 'manipulation' }}
            >
              {byPasskey.isPending ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Fingerprint size={16} />
              )}
              Use a passkey
            </button>
          )}

          {status.data.canUsePassword && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (password) byPassword.mutate();
              }}
            >
              <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                <Lock size={14} className="shrink-0 text-text-secondary" />
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your password"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none"
                />
              </label>
              <button
                type="submit"
                disabled={busy || !password}
                className="rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
                style={{ touchAction: 'manipulation' }}
              >
                {byPassword.isPending ? 'Confirming…' : 'Confirm'}
              </button>
            </form>
          )}
        </div>
      )}

      {message && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{message}</p>}

      <button
        type="button"
        onClick={onCancel}
        className="mt-3 text-xs text-text-secondary underline"
        style={{ touchAction: 'manipulation' }}
      >
        Cancel
      </button>
    </div>
  );
}
