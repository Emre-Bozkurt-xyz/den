/**
 * Owner console — read-only (docs/ADMIN_CONSOLE.md §3, §8; build steps 1-3).
 *
 * ⚠️ Everything here is operator information: accounts, credentials, sessions,
 * locks, invites, push health, and the security feed. Nothing on this screen
 * shows message content, media, or who talks to whom — the owner is an
 * operator, not a reader (§2), and that is what keeps hard invariant 1 intact
 * rather than carved into. If a future panel here seems to need chat data,
 * redesign the panel.
 *
 * ⚠️ Layout note (§8): six of these views are naturally tables and everyone is
 * on a phone. They render as stacked cards, never as horizontally scrolling
 * tables — the page body must never scroll sideways.
 *
 * Styling is plain; the owner does a UI pass separately.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, KeyRound, Loader2, Lock, Plus, Shield, Ticket, Trash2, Unlock, UserX, Users } from 'lucide-react';
import type { SecurityEvent } from '@den/shared';
import { ScreenHeader } from './ScreenHeader';
import { ReauthPrompt } from './ReauthPrompt';
import { ApiFetchError } from '../lib/api';
import {
  adminEvents,
  adminInvites,
  adminLocks,
  adminPushHealth,
  adminUsers,
  clearLock,
  disableUser,
  enableUser,
  isReauthRequired,
  mintInvites,
  revokeInvite,
  revokeSessions,
  setGlobalSigninFreeze,
  setUserSigninFreeze,
  signinFreeze,
} from '../lib/admin';

type Tab = 'feed' | 'users' | 'invites' | 'locks';

const TABS: { id: Tab; label: string; icon: typeof Shield }[] = [
  { id: 'feed', label: 'Activity', icon: Shield },
  { id: 'users', label: 'People', icon: Users },
  { id: 'invites', label: 'Invites', icon: Ticket },
  { id: 'locks', label: 'Locks', icon: AlertTriangle },
];

export function AdminConsole({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>('feed');
  // System-back is routed by App.tsx's `parentOf` (admin → settings), the same
  // way Settings relies on it. Registering a handler here too would double-pop.

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Admin" onBack={onBack} />

      <div
        className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        style={{
          paddingLeft: 'max(env(safe-area-inset-left), 1rem)',
          paddingRight: 'max(env(safe-area-inset-right), 1rem)',
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tab === t.id}
              onClick={() => setTab(t.id)}
              className={
                'flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-medium transition-colors ' +
                (tab === t.id ? 'bg-accent text-white' : 'bg-surface-sunken text-text-secondary hover:bg-border')
              }
              style={{ touchAction: 'manipulation' }}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'feed' && <FeedPanel />}
        {tab === 'users' && <UsersPanel />}
        {tab === 'invites' && <InvitesPanel />}
        {tab === 'locks' && <LocksPanel />}
      </div>
    </div>
  );
}


/**
 * Runs a destructive admin action, and when the server says proof of identity
 * has gone stale, shows the re-auth prompt and RETRIES the same action once
 * it's satisfied.
 *
 * ⚠️ The pending action is held so the retry is automatic. Making the user
 * re-find the button they already pressed is how a security prompt becomes the
 * thing people route around.
 */
function useGuardedAction(onDone: () => void) {
  const [pending, setPending] = useState<{ run: () => Promise<unknown>; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (job: { run: () => Promise<unknown>; label: string }) => job.run(),
    onSuccess: () => {
      setPending(null);
      setError(null);
      onDone();
    },
    onError: (err, job) => {
      if (isReauthRequired(err)) {
        setPending(job);
        setError(null);
        return;
      }
      setError(err instanceof ApiFetchError ? err.message : 'That did not work — try again.');
    },
  });

  return {
    run: (label: string, fn: () => Promise<unknown>) => mutation.mutate({ run: fn, label }),
    busy: mutation.isPending,
    error,
    /** Rendered by the caller when non-null. */
    prompt: pending && (
      <ReauthPrompt
        action={pending.label}
        onConfirmed={() => mutation.mutate(pending)}
        onCancel={() => setPending(null)}
      />
    ),
  };
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Pending() {
  return (
    <p className="flex items-center gap-2 text-sm text-text-secondary">
      <Loader2 size={14} className="animate-spin" /> Loading…
    </p>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-text-secondary">{children}</p>;
}

// ─── activity feed ──────────────────────────────────────────────────────────

/** Human phrasing per event kind. Unknown kinds fall through to the raw kind
 *  rather than being hidden — an event nobody can read still beats silence. */
function describe(e: SecurityEvent): string {
  const who = e.username ?? 'someone';
  switch (e.kind) {
    case 'login.locked':
      return `${who} was locked out after ${String(e.data.failures ?? 'repeated')} failed sign-ins`;
    case 'session.new_device':
      return `${who} signed in from an unfamiliar device (${String(e.data.method ?? '?')})`;
    case 'credential.added':
      return `${who} added a passkey${e.data.label ? ` — ${String(e.data.label)}` : ''}`;
    case 'credential.removed':
      return `${who} removed a passkey`;
    case 'invite.claimed':
      return `${who} joined with an invite`;
    case 'lock.cleared':
      return `${who}'s lock was cleared`;
    case 'invite.revoked':
      return 'an invite was revoked';
    case 'session.revoked':
      return `a session for ${who} was revoked`;
    case 'user.disabled':
      return `${who} was disabled`;
    case 'user.enabled':
      return `${who} was re-enabled`;
    case 'signin.frozen':
      return e.data.scope === 'global' ? 'sign-ins were frozen for everyone' : `sign-in was frozen for ${who}`;
    case 'signin.unfrozen':
      return e.data.scope === 'global' ? 'sign-ins were unfrozen for everyone' : `sign-in was unfrozen for ${who}`;
    case 'signin.blocked':
      return `${who} signed in correctly but was blocked by the freeze`;
    default:
      return `${e.kind} — ${who}`;
  }
}

function FeedPanel() {
  const q = useQuery({ queryKey: ['admin', 'events'], queryFn: () => adminEvents() });

  return (
    <Panel title="Recent security activity">
      {q.isPending && <Pending />}
      {q.isSuccess && q.data.events.length === 0 && <Empty>Nothing recorded yet.</Empty>}
      {q.isSuccess && q.data.events.length > 0 && (
        <ul className="flex flex-col gap-2">
          {q.data.events.map((e) => (
            <li key={e.id} className="rounded-md bg-surface-sunken px-3 py-2">
              <p className="text-sm text-text-primary">{describe(e)}</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {new Date(e.createdAt).toLocaleString()}
                {e.actorUsername ? ` · by ${e.actorUsername}` : ''}
                {e.ip ? ` · ${e.ip}` : ''}
              </p>
              {e.userAgent && (
                <p className="mt-0.5 truncate text-xs text-text-secondary">{e.userAgent}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── people ─────────────────────────────────────────────────────────────────

function UsersPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'users'], queryFn: adminUsers });
  const push = useQuery({ queryKey: ['admin', 'push'], queryFn: adminPushHealth });
  const act = useGuardedAction(() => {
    void qc.invalidateQueries({ queryKey: ['admin'] });
  });

  return (
    <>
      <Panel title="People">
        {act.prompt}
        {act.error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{act.error}</p>}
        {q.isPending && <Pending />}
        {q.isSuccess && (
          <ul className="flex flex-col gap-2">
            {q.data.users.map((u) => (
              <li key={u.id} className="rounded-md bg-surface-sunken px-3 py-2">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-sm text-text-primary">
                    {u.displayName}{' '}
                    <span className="text-text-secondary">@{u.username}</span>
                  </p>
                  {u.isOwner && (
                    <span className="shrink-0 rounded-pill bg-accent px-2 py-0.5 text-[10px] font-semibold text-white">
                      owner
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  {u.hasPassword ? 'password' : 'no password'} ·{' '}
                  {u.passkeyCount === 1 ? '1 passkey' : `${u.passkeyCount} passkeys`} ·{' '}
                  {u.activeSessions === 1 ? '1 session' : `${u.activeSessions} sessions`}
                  {u.vaultLinked ? ' · vault' : ''}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  Joined {new Date(u.createdAt).toLocaleDateString()}
                  {u.lastSeenAt ? ` · last signed in ${new Date(u.lastSeenAt).toLocaleDateString()}` : ' · never signed in'}
                </p>
                {u.disabledAt && (
                  <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">Disabled</p>
                )}
                {(u.loginsFrozenAt || u.globalFrozen) && (
                  <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                    Sign-in frozen
                    {u.loginsFrozenAt && u.globalFrozen
                      ? ' (this account + global)'
                      : u.globalFrozen
                        ? ' (global switch)'
                        : ' (this account)'}
                  </p>
                )}

                {/* The owner's own row gets no destructive controls: disabling
                    yourself is refused server-side, and revoking your own
                    sessions mid-incident is a way to make things worse. */}
                {!u.isOwner && (
                  <div className="mt-2 flex flex-wrap gap-3">
                    {u.activeSessions > 0 && (
                      <button
                        type="button"
                        disabled={act.busy}
                        onClick={() =>
                          act.run(`signing @${u.username} out everywhere`, () => revokeSessions(u.id))
                        }
                        className="text-xs font-semibold text-indigo-600 disabled:opacity-40 dark:text-indigo-400"
                        style={{ touchAction: 'manipulation' }}
                      >
                        Sign out all devices
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={act.busy}
                      onClick={() =>
                        act.run(
                          u.loginsFrozenAt ? `unfreezing @${u.username}` : `freezing @${u.username}`,
                          () => setUserSigninFreeze(u.id, !u.loginsFrozenAt),
                        )
                      }
                      className="flex items-center gap-1 text-xs font-semibold text-indigo-600 disabled:opacity-40 dark:text-indigo-400"
                      style={{ touchAction: 'manipulation' }}
                    >
                      {u.loginsFrozenAt ? <Unlock size={12} /> : <Lock size={12} />}
                      {u.loginsFrozenAt ? 'Allow sign-in' : 'Freeze sign-in'}
                    </button>
                    <button
                      type="button"
                      disabled={act.busy}
                      onClick={() =>
                        u.disabledAt
                          ? act.run(`re-enabling @${u.username}`, () => enableUser(u.id))
                          : act.run(`disabling @${u.username}`, () => disableUser(u.id))
                      }
                      className="flex items-center gap-1 text-xs font-semibold text-red-600 disabled:opacity-40 dark:text-red-400"
                      style={{ touchAction: 'manipulation' }}
                    >
                      <UserX size={12} /> {u.disabledAt ? 'Re-enable' : 'Disable'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="mt-4">
        <Panel title="Push health">
          {push.isPending && <Pending />}
          {push.isSuccess && !push.data.pushConfigured && (
            <p className="mb-2 text-xs text-red-600 dark:text-red-400">
              VAPID isn&apos;t configured on this server — nobody can receive notifications,
              regardless of the numbers below.
            </p>
          )}
          {push.isSuccess && (
            <ul className="flex flex-col gap-1.5">
              {push.data.users.map((u) => (
                <li key={u.userId} className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="truncate text-text-primary">@{u.username}</span>
                  <span
                    className={
                      'shrink-0 text-xs ' +
                      (u.subscriptions === 0 ? 'text-red-600 dark:text-red-400' : 'text-text-secondary')
                    }
                  >
                    {u.subscriptions === 0
                      ? 'no devices'
                      : u.subscriptions === 1
                        ? '1 device'
                        : `${u.subscriptions} devices`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

// ─── invites ────────────────────────────────────────────────────────────────

function InvitesPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'invites'], queryFn: adminInvites });
  const [minted, setMinted] = useState<string[]>([]);
  const act = useGuardedAction(() => {
    void qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
  });

  const mint = useMutation({
    mutationFn: () => mintInvites(1),
    onSuccess: (r) => {
      setMinted((prev) => [...r.codes, ...prev]);
      void qc.invalidateQueries({ queryKey: ['admin', 'invites'] });
    },
  });

  return (
    <Panel title="Invites">
      {act.prompt}
      {act.error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{act.error}</p>}

      <button
        type="button"
        disabled={mint.isPending}
        onClick={() => mint.mutate()}
        className="mb-3 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold transition-colors hover:bg-surface-hover disabled:opacity-40"
        style={{ touchAction: 'manipulation' }}
      >
        {mint.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        Mint an invite
      </button>

      {minted.length > 0 && (
        <div className="mb-3 rounded-md border border-accent bg-surface-sunken p-3">
          <p className="text-xs text-text-secondary">
            Just minted — copy it now, it&apos;s only listed here while this screen is open:
          </p>
          {minted.map((c) => (
            <p key={c} className="mt-1 break-all font-mono text-sm text-text-primary">
              {c}
            </p>
          ))}
        </div>
      )}
      {q.isPending && <Pending />}
      {q.isSuccess && q.data.invites.length === 0 && <Empty>No invite codes.</Empty>}
      {q.isSuccess && q.data.invites.length > 0 && (
        <ul className="flex flex-col gap-2">
          {q.data.invites.map((i) => (
            <li key={i.code} className="rounded-md bg-surface-sunken px-3 py-2">
              <p className="break-all font-mono text-sm text-text-primary">{i.code}</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {i.usedByUsername
                  ? `Claimed by @${i.usedByUsername}${i.usedAt ? ` on ${new Date(i.usedAt).toLocaleDateString()}` : ''}`
                  : i.revokedAt
                    ? 'Revoked'
                    : 'Unused'}
                {' · created '}
                {new Date(i.createdAt).toLocaleDateString()}
              </p>
              {i.claimable && (
                <button
                  type="button"
                  disabled={act.busy}
                  onClick={() => act.run(`revoking that invite`, () => revokeInvite(i.code))}
                  className="mt-1.5 flex items-center gap-1 text-xs font-semibold text-red-600 disabled:opacity-40 dark:text-red-400"
                  style={{ touchAction: 'manipulation' }}
                >
                  <Trash2 size={12} /> Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-text-secondary">
        Only unused codes can be revoked. A claimed code is history — revoking it would imply
        something about the account it created, which is what disabling is for.
      </p>
    </Panel>
  );
}

// ─── locks ──────────────────────────────────────────────────────────────────

function LocksPanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'locks'], queryFn: adminLocks, refetchInterval: 15_000 });
  const act = useGuardedAction(() => {
    void qc.invalidateQueries({ queryKey: ['admin'] });
  });

  return (
    <>
      <GlobalFreezePanel />
      <div className="mt-4" />
      <Panel title="Failed sign-ins">
      {act.prompt}
      {act.error && <p className="mb-2 text-sm text-red-600 dark:text-red-400">{act.error}</p>}
      {q.isPending && <Pending />}
      {q.isSuccess && q.data.locks.length === 0 && (
        <Empty>No failed sign-ins in the last 15 minutes.</Empty>
      )}
      {q.isSuccess && q.data.locks.length > 0 && (
        <ul className="flex flex-col gap-2">
          {q.data.locks.map((l) => (
            <li key={l.username} className="rounded-md bg-surface-sunken px-3 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate font-mono text-sm text-text-primary">{l.username}</p>
                {l.locked && (
                  <span className="shrink-0 rounded-pill bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                    locked {Math.ceil(l.retryAfterSeconds / 60)}m
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-text-secondary">
                {l.failures} {l.failures === 1 ? 'failure' : 'failures'}
                {l.lastFailureAt ? ` · last ${new Date(l.lastFailureAt).toLocaleTimeString()}` : ''}
              </p>
              <button
                type="button"
                disabled={act.busy}
                onClick={() => act.run(`clearing ${l.username}`, () => clearLock(l.username))}
                className="mt-1.5 text-xs font-semibold text-indigo-600 disabled:opacity-40 dark:text-indigo-400"
                style={{ touchAction: 'manipulation' }}
              >
                Clear
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-xs text-text-secondary">
        <KeyRound size={12} className="mt-0.5 shrink-0" />
        <span>
          A username here may not be a real account — failures are recorded for names that
          don&apos;t exist too, so a lock can&apos;t reveal who has an account. Clear one with{' '}
          <span className="font-mono">npm run auth:unlock clear &lt;username&gt;</span>.
        </span>
      </p>
      </Panel>
    </>
  );
}

/**
 * The server-wide sign-in freeze (docs/SIGNIN_FREEZE.md §6).
 *
 * ⚠️ The copy has to be exact about what this does, because the failure mode
 * is an owner who thinks it signs people out (it does not) or who forgets it
 * is on and quietly locks out a friend whose session expired.
 */
function GlobalFreezePanel() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'freeze'], queryFn: signinFreeze });

  const toggle = useMutation({
    mutationFn: (frozen: boolean) => setGlobalSigninFreeze(frozen),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });

  const frozen = Boolean(q.data?.globalFrozenAt);

  return (
    <section
      className={
        'rounded-lg border p-4 ' +
        (frozen ? 'border-red-600 bg-surface-raised dark:border-red-400' : 'border-border bg-surface-raised')
      }
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        {frozen ? <Lock size={15} /> : <Unlock size={15} />} Sign-in freeze
      </h3>

      {q.isPending && <Pending />}

      {q.isSuccess && (
        <>
          <p className="mt-2 text-xs text-text-secondary">
            {frozen
              ? 'No account can start a new session — not with a password, not with a passkey, even if the credentials are right. Everyone already signed in is unaffected.'
              : 'Sign-ins are open. Freeze to stop any new session being created while everyone who needs access is already signed in.'}
          </p>

          <button
            type="button"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(!frozen)}
            className={
              'mt-3 flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40 ' +
              (frozen
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'border border-border hover:bg-surface-hover')
            }
            style={{ touchAction: 'manipulation' }}
          >
            {toggle.isPending ? <Loader2 size={14} className="animate-spin" /> : frozen ? <Unlock size={14} /> : <Lock size={14} />}
            {frozen ? 'Unfreeze everyone' : 'Freeze all sign-ins'}
          </button>

          {frozen && (
            <p className="mt-2 text-xs text-text-secondary">
              ⚠️ Anyone who gets signed out while this is on — an expired session, cleared site
              data, a reinstalled PWA — will need you to unfreeze before they can get back in.
              You&apos;ll get a notification if someone with the right credentials is turned away.
            </p>
          )}

          {(q.data.frozenUsernames.length > 0) && (
            <p className="mt-2 text-xs text-text-secondary">
              Individually frozen (independent of this switch):{' '}
              <span className="font-mono">{q.data.frozenUsernames.join(', ')}</span>
            </p>
          )}
        </>
      )}
    </section>
  );
}
