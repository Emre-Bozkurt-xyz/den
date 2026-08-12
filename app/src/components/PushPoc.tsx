import { useState } from 'react';
import { enablePush, sendTestPush, pushSupported } from '../lib/push';
import { isStandalone } from '../lib/pwa';
import { ApiFetchError } from '../lib/api';

type Status = { kind: 'idle' | 'ok' | 'err'; msg: string };

function describe(e: unknown): string {
  if (e instanceof ApiFetchError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return 'Unknown error';
}

/**
 * Settings → Notifications (docs/MEDIA_ATTACHMENTS.md §5.6) — the real,
 * always-visible home for enabling Web Push, promoted out of the collapsible
 * DebugTools panel it used to share with the PoC's "Send test" button.
 *
 * ⚠️ The `onEnable` click must stay a synchronous call into `enablePush()`
 * from inside the click handler, exactly as before: iOS requires the
 * permission prompt to be raised from a real user gesture (CLAUDE.md
 * platform reality / BACKBONE §8). Do not wrap this in anything that defers
 * the call past the click (no setTimeout, no awaited pre-check, no extra
 * promise hop before `enablePush()` is invoked).
 */
export function NotificationsSection() {
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: '' });
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();

  async function onEnable() {
    setBusy(true);
    try {
      await enablePush();
      setStatus({ kind: 'ok', msg: 'Notifications enabled.' });
    } catch (e) {
      setStatus({ kind: 'err', msg: describe(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <h3 className="text-sm font-semibold text-text-primary">Notifications</h3>
      <p className="mt-1 text-xs text-text-secondary">
        Get push notifications for new messages. On iPhone this only works from the installed app.
      </p>

      {!supported && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">
          This browser reports no Push support.
          {!isStandalone() && ' On iPhone, install to Home Screen first.'}
        </p>
      )}

      <button
        onClick={onEnable}
        disabled={busy || !supported}
        className="mt-3 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
      >
        Enable notifications
      </button>

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

/**
 * Debug-only remainder of the original Push PoC panel — "Send test" against
 * the caller's own subscriptions. "Enable notifications" moved to the real
 * `NotificationsSection` above; this stays inside DebugTools for real-device
 * testing (CLAUDE.md: "keeping debugging easy for future testing").
 */
export function PushPoc() {
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: '' });
  const [busy, setBusy] = useState(false);

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
      <h2 className="text-base font-semibold">Push PoC — send test</h2>
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        Sends a test push to your own subscriptions. Use "Enable notifications" in Settings first.
      </p>

      <div className="mt-3">
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
