/**
 * The decision half of `lib/pwa.ts`'s update reload, kept pure so it can be
 * unit-tested without a service worker or a DOM.
 *
 * A new SW has taken control (controllerchange) → the page must reload once
 * so it stops running the old bundle. But not while that would destroy
 * something (`lib/busy.ts`):
 *  - an upload in flight blocks the reload even while hidden — on Android a
 *    backgrounded PWA keeps uploading, and killing it would abandon a
 *    half-sent album server-side; the hold is bounded (stall watchdog +
 *    api.ts timeouts), so this can't defer forever;
 *  - composer content (draft / staged / recording) blocks only while the page
 *    is visible. It's unbounded, and "old JS against a new server" must not
 *    last indefinitely, so going hidden is the cut-off.
 */
export interface ReloadGateDeps {
  isUploading(): boolean;
  isBusy(): boolean;
  isHidden(): boolean;
  reload(): void;
}

export interface ReloadGate {
  /** An update is waiting (controllerchange). Reloads now if nothing blocks. */
  request(): void;
  /** Re-evaluate — call when busy state or visibility changes. No-op unless
   *  an update was requested. Never reloads twice. */
  attempt(): void;
}

export function createReloadGate(deps: ReloadGateDeps): ReloadGate {
  let pending = false;
  let fired = false;

  function attempt(): void {
    if (!pending || fired) return;
    if (deps.isUploading()) return;
    if (deps.isBusy() && !deps.isHidden()) return;
    fired = true;
    deps.reload();
  }

  return {
    request() {
      pending = true;
      attempt();
    },
    attempt,
  };
}
