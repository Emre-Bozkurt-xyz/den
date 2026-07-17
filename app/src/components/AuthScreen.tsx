import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AuthLimits } from '@den/shared';
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
    <div className="min-h-[100dvh] bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div
        className="mx-auto flex min-h-[100dvh] max-w-sm flex-col justify-center gap-6 px-6"
        style={{
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <div className="text-center">
          <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600 text-2xl font-bold text-white">
            D
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Den</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
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
            />
          )}
          <Field
            label="Username"
            value={username}
            onChange={(v) => setUsername(v.toLowerCase())}
            placeholder="lowercase, a–z 0–9 _ -"
            autoCapitalize="none"
            autoComplete="username"
          />
          {mode === 'register' && (
            <Field
              label="Display name"
              value={displayName}
              onChange={setDisplayName}
              placeholder="How your name shows up"
            />
          )}
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder={`at least ${AuthLimits.passwordMin} characters`}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />

          {message && <p className="text-sm text-red-600 dark:text-red-400">{message}</p>}

          <button
            type="submit"
            disabled={mutation.isPending}
            className="mt-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {mutation.isPending ? '…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
          {mode === 'login' ? "Have an invite?" : 'Already have an account?'}{' '}
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
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
        {props.label}
      </span>
      <input
        className="rounded-xl border border-black/10 bg-white px-3 py-2.5 text-base outline-none focus:border-indigo-500 dark:border-white/15 dark:bg-neutral-900"
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
        autoCapitalize={props.autoCapitalize}
        autoCorrect="off"
        spellCheck={false}
      />
    </label>
  );
}
