import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AuthLimits } from '@den/shared';
import { AtSign, KeyRound, Loader2, Lock, User as UserIcon } from 'lucide-react';
import { login, register } from '../lib/auth';
import { ApiFetchError } from '../lib/api';

type Mode = 'login' | 'register';

/** Login / register screen. Shown whenever there is no session (App gates on it). */
export function AuthScreen() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('login');
  const [inviteCode, setInviteCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === 'login') return login({ username, password });
      return register({ inviteCode: inviteCode.trim(), username, displayName, password });
    },
    onSuccess: (user) => {
      // Prime the cache so the app switches over without a refetch flash.
      qc.setQueryData(['me'], user);
    },
  });

  const err = mutation.error;
  const message =
    err instanceof ApiFetchError ? err.message : err instanceof Error ? err.message : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <div className="min-h-[100dvh] bg-surface text-text-primary">
      <div
        className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-6 px-6"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-lg bg-accent text-2xl font-bold text-white">
            D
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Den</h1>
          <p className="text-sm text-text-secondary">
            {mode === 'login' ? 'Welcome back.' : 'You need an invite to join.'}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === 'register' && (
            <Field
              label="Invite code"
              value={inviteCode}
              onChange={setInviteCode}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoCapitalize="characters"
              icon={KeyRound}
            />
          )}
          <Field
            label="Username"
            value={username}
            onChange={(v) => setUsername(v.toLowerCase())}
            placeholder="lowercase, a–z 0–9 _ -"
            autoCapitalize="none"
            autoComplete="username"
            icon={AtSign}
          />
          {mode === 'register' && (
            <Field
              label="Display name"
              value={displayName}
              onChange={setDisplayName}
              placeholder="How your name shows up"
              icon={UserIcon}
            />
          )}
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder={`at least ${AuthLimits.passwordMin} characters`}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            icon={Lock}
          />

          {message && <p className="text-sm text-red-600 dark:text-red-400">{message}</p>}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="mt-1 flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
          >
            {mutation.isPending && <Loader2 size={16} className="animate-spin" />}
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-sm text-text-secondary">
          {mode === 'login' ? 'Have an invite?' : 'Already have an account?'}{' '}
          <button
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              mutation.reset();
            }}
            className="font-semibold text-indigo-600 dark:text-indigo-400"
          >
            {mode === 'login' ? 'Register' : 'Log in'}
          </button>
        </p>
      </div>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  autoCapitalize?: string;
  icon: typeof AtSign;
}) {
  const Icon = props.icon;
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text-secondary">{props.label}</span>
      <div className="relative">
        <Icon size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          className="w-full rounded-md border border-border bg-surface-raised py-2.5 pl-9 pr-3 text-base outline-none focus:border-accent"
          type={props.type ?? 'text'}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete}
          autoCapitalize={props.autoCapitalize}
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
    </label>
  );
}
