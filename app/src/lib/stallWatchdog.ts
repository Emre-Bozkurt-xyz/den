/**
 * Fires `onStall` once if `kick` isn't called again within the window passed
 * to the last `kick`. Used by `lib/media.ts`'s presigned PUT: an idle timer,
 * NOT a total-duration cap — a large video on a slow link is legitimate as
 * long as bytes keep moving.
 *
 * Timers are looked up on `globalThis` at call time (not captured at import)
 * so `node:test`'s mock timers can drive it.
 */
export interface StallWatchdog {
  /** Restart the window. Ignored once stopped or fired. */
  kick(ms: number): void;
  /** Disarm for good. Idempotent. */
  stop(): void;
}

export function createStallWatchdog(onStall: () => void): StallWatchdog {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  return {
    kick(ms) {
      if (done) return;
      if (handle !== undefined) globalThis.clearTimeout(handle);
      handle = globalThis.setTimeout(() => {
        done = true;
        onStall();
      }, ms);
    },
    stop() {
      done = true;
      if (handle !== undefined) globalThis.clearTimeout(handle);
      handle = undefined;
    },
  };
}
