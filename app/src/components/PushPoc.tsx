import { useState } from 'react';
import { enablePush, sendTestPush, pushSupported } from '../lib/push';
import { isStandalone } from '../lib/pwa';
import { ApiFetchError } from '../lib/api';

type Status = { kind: 'idle' | 'ok' | 'err'; msg: string };

/**
 * Web Push panel — originally the Stage 0 GO/NO-GO gate, now also the debug
 * entry point for the real (Stage 2) subscription flow. The "Enable
 * notifications" click is the user gesture iOS requires for the permission
 * prompt (BACKBONE §8). "Send test" only pushes to the caller's own devices.
 */
export function PushPoc() {
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: '' });
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();

  async function onEnable() {
    setBusy(true);
    try {
      await enablePush();
      setStatus({ kind: 'ok', msg: 'Subscribed. Now tap "Send test" — background the app first.' });
    } catch (e) {
      setStatus({ kind: 'err', msg: describe(e) });
    } finally {
      setBusy(false);
    }
  }

  async function onTest() {
    setBusy(true);
    try {
      const { delivered, total } = await sendTestPush();
      setStatus({ kind: 'ok', msg: `Server sent to ${delivered}/${total} subscription(s).` });
    } catch (e) {
      setStatus({ kind: 'err', msg: describe(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/10 dark:bg-neutral-900">
      <h2 className="text-base font-semibold">Push PoC</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        GO/NO-GO gate for iOS Web Push (§14). On iPhone this only works from the installed app.
      </p>

      {!supported && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          This browser reports no Push support.
          {!isStandalone() && ' On iPhone, install to Home Screen first.'}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={onEnable}
          disabled={busy || !supported}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Enable notifications
        </button>
        <button
          onClick={onTest}
          disabled={busy}
          className="rounded-md border border-black/10 px-4 py-2 text-sm font-medium dark:border-white/15"
        >
          Send test
        </button>
      </div>

      {status.kind !== 'idle' && (
        <p
          className={
            'mt-3 text-sm ' +
            (status.kind === 'ok'
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400')
          }
        >
          {status.msg}
        </p>
      )}
    </section>
  );
}

function describe(e: unknown): string {
  if (e instanceof ApiFetchError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return 'Unknown error';
}
