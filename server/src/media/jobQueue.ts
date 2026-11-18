/**
 * Small in-process job queue for media processing (audit fix 2026-11-18).
 * Deliberately dependency-free (no DB, no R2, no sharp/ffmpeg imports) so its
 * logic is unit-testable on its own — see jobQueue.test.ts.
 *
 * Two jobs it does, both of which used to be missing:
 *
 *  1. **One job per key, ever.** A key (the media id) is "in flight" from the
 *     moment it is accepted until its job settles — INCLUDING the time it sits
 *     queued behind other work. A second `run()` for the same key returns
 *     null instead of starting a duplicate. Den runs exactly one API process
 *     (deploy/docker-compose.yml has one `api` service), so a process-local
 *     Set is the whole truth about what is running; across a restart nothing
 *     is running, which is what the sweeper (sweeper.ts) relies on.
 *
 *  2. **Bounded concurrency per lane.** Every upload-complete used to start a
 *     transcode immediately, so ten videos meant ten concurrent libx264
 *     encodes on a small VPS, each then hitting the 90s cap and falling back
 *     to the original. Lanes let video run one-at-a-time while cheap image /
 *     voice work keeps flowing beside it.
 *
 * `drain()` is for graceful shutdown: it stops accepting work, cancels jobs
 * that haven't started (their rows stay 'processing' and the sweeper picks
 * them up after the restart), and waits — bounded — for running ones.
 */

/** Rejection for a job that was accepted but never started because the
 *  queue was drained first. Callers treat it as "left for the sweeper", not
 *  as a processing failure. */
export class QueueClosedError extends Error {
  constructor() {
    super('job queue closed before this job started');
    this.name = 'QueueClosedError';
  }
}

interface Waiting {
  start: () => void;
  cancel: () => void;
}

export class KeyedJobQueue<L extends string> {
  private readonly inFlight = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private readonly active: Record<string, number> = {};
  private readonly waiting: Record<string, Waiting[]> = {};
  private closed = false;

  constructor(private readonly limits: Record<L, number>) {
    for (const lane of Object.keys(limits)) {
      this.active[lane] = 0;
      this.waiting[lane] = [];
    }
  }

  /** True while `key` is queued or running. */
  has(key: string): boolean {
    return this.inFlight.has(key);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Accept `job` for `key` on `lane`. Returns null — and runs nothing — if
   * the key is already in flight or the queue is closed; otherwise a promise
   * for the job's result (rejects with QueueClosedError if drained before it
   * started).
   *
   * ⚠️ The has/add pair below has no `await` between it, so two callers can
   * never both pass the check — same reasoning the old `firstCompleteClaimed`
   * relied on, now applied to "is a job running for this id".
   */
  run<T>(key: string, lane: L, job: () => Promise<T>): Promise<T> | null {
    if (this.closed || this.inFlight.has(key)) return null;
    this.inFlight.add(key);

    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active[lane]! += 1;
        // Bookkeeping is released BEFORE the caller's promise settles, so a
        // caller reacting to "done" can immediately run the same key again.
        const release = () => {
          this.active[lane]! -= 1;
          this.inFlight.delete(key);
          this.running.delete(settled);
          this.startNext(lane);
        };
        const settled: Promise<void> = Promise.resolve()
          .then(job) // a synchronous throw inside `job` becomes a rejection, not a crash
          .then(
            (value) => {
              release();
              resolve(value);
            },
            (err: unknown) => {
              release();
              reject(err);
            },
          );
        this.running.add(settled);
      };
      const cancel = () => {
        this.inFlight.delete(key);
        reject(new QueueClosedError());
      };

      if (this.active[lane]! < this.limits[lane]) start();
      else this.waiting[lane]!.push({ start, cancel });
    });
  }

  private startNext(lane: string): void {
    if (this.closed) return;
    const limit = this.limits[lane as L];
    while (this.active[lane]! < limit && this.waiting[lane]!.length > 0) {
      this.waiting[lane]!.shift()!.start();
    }
  }

  /**
   * Stop accepting work, cancel everything not yet started, and wait up to
   * `timeoutMs` for running jobs to settle. Resolves true if they all did,
   * false on timeout (the caller shuts down anyway; the unfinished rows stay
   * 'processing' for the sweeper). Safe to call more than once.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    this.closed = true;
    for (const lane of Object.keys(this.waiting)) {
      const queued = this.waiting[lane]!.splice(0);
      for (const w of queued) w.cancel();
    }
    if (this.running.size === 0) return true;

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    // `running` entries never reject (resolve/reject are handled inside), so
    // Promise.all here only ever resolves.
    const allDone = Promise.all([...this.running]).then(() => true as const);
    try {
      return await Promise.race([allDone, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
