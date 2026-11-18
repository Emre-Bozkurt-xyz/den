/**
 * A tiny token bucket for inbound WS frames (ws.ts). Pure — the clock is
 * injected — so it is unit-testable without a socket.
 *
 * Why a bucket and not a fixed window: a real person's traffic is bursty
 * (open the app → a delivered.ack per chat, a presence report, a typing
 * frame, then quiet), and a bucket lets that burst through whole while still
 * bounding the sustained rate a flooding client can reach. A fixed window
 * would either be tight enough to clip the burst or loose enough to allow 2×
 * the limit across a window edge.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  /** Spend one token if there is one. Returns false (and spends nothing)
   *  when the bucket is empty. */
  take(now: number = Date.now()): boolean {
    // A clock that goes backwards (NTP step) must not mint tokens or wedge
    // the bucket — treat it as no time having passed.
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
