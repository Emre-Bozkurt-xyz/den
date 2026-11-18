/**
 * Pure-logic tests for the media job queue (jobQueue.ts) — no DB, no R2, no
 * ffmpeg, so these run anywhere: `node --import tsx --test src/media/jobQueue.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { KeyedJobQueue, QueueClosedError } from './jobQueue.js';

/** A job whose completion the test controls. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('KeyedJobQueue', () => {
  test('a second run() for an in-flight key returns null and never runs', async () => {
    const q = new KeyedJobQueue({ video: 1 });
    const d = deferred<string>();
    let calls = 0;
    const first = q.run('42', 'video', () => {
      calls++;
      return d.promise;
    });
    assert.ok(first);
    assert.equal(q.has('42'), true);
    assert.equal(q.run('42', 'video', async () => { calls++; return 'dup'; }), null);

    d.resolve('done');
    assert.equal(await first, 'done');
    assert.equal(calls, 1);
    assert.equal(q.has('42'), false, 'key is released once the job settles');
  });

  test('a key stays in flight while it is queued, not just while running', async () => {
    const q = new KeyedJobQueue({ video: 1 });
    const blocker = deferred();
    void q.run('a', 'video', () => blocker.promise);
    const queued = q.run('b', 'video', async () => 'b');
    assert.ok(queued);
    assert.equal(q.has('b'), true);
    assert.equal(q.run('b', 'video', async () => 'dup'), null);
    blocker.resolve();
    assert.equal(await queued, 'b');
  });

  test('a key can run again after its job failed', async () => {
    const q = new KeyedJobQueue({ light: 2 });
    await assert.rejects(q.run('1', 'light', async () => { throw new Error('boom'); })!, /boom/);
    assert.equal(q.has('1'), false);
    assert.equal(await q.run('1', 'light', async () => 'ok'), 'ok');
  });

  test('a synchronous throw inside the job becomes a rejection', async () => {
    const q = new KeyedJobQueue({ light: 1 });
    await assert.rejects(q.run('1', 'light', () => { throw new Error('sync'); })!, /sync/);
    assert.equal(q.has('1'), false);
  });

  test('per-lane concurrency is respected, and lanes do not block each other', async () => {
    const q = new KeyedJobQueue({ video: 1, light: 2 });
    let videoRunning = 0;
    let maxVideo = 0;
    const videos = Array.from({ length: 3 }, () => deferred());
    const videoJobs = videos.map((d, i) =>
      q.run(`v${i}`, 'video', async () => {
        videoRunning++;
        maxVideo = Math.max(maxVideo, videoRunning);
        await d.promise;
        videoRunning--;
      }),
    );

    // An image job is not stuck behind the queued videos.
    let imageRan = false;
    await q.run('img', 'light', async () => { imageRan = true; });
    assert.equal(imageRan, true);

    for (const d of videos) {
      d.resolve();
      await tick();
    }
    await Promise.all(videoJobs);
    assert.equal(maxVideo, 1, 'video lane must never run two encodes at once');
  });

  test('drain() refuses new work, cancels queued jobs, and waits for running ones', async () => {
    const q = new KeyedJobQueue({ video: 1 });
    const running = deferred();
    let runningFinished = false;
    const r = q.run('run', 'video', async () => {
      await running.promise;
      runningFinished = true;
    });
    let queuedStarted = false;
    const queued = q.run('queued', 'video', async () => { queuedStarted = true; });

    const drained = q.drain(5_000);
    assert.equal(q.run('late', 'video', async () => undefined), null, 'closed queue accepts nothing');
    await assert.rejects(queued!, (e: unknown) => e instanceof QueueClosedError);
    assert.equal(q.has('queued'), false);

    running.resolve();
    assert.equal(await drained, true);
    await r;
    assert.equal(runningFinished, true);
    assert.equal(queuedStarted, false, 'a cancelled job must never start');
  });

  test('drain() resolves false when a running job outlives the timeout', async () => {
    const q = new KeyedJobQueue({ video: 1 });
    const never = deferred();
    void q.run('stuck', 'video', () => never.promise);
    assert.equal(await q.drain(20), false);
    never.resolve();
  });

  test('drain() on an idle queue resolves true immediately', async () => {
    const q = new KeyedJobQueue({ video: 1 });
    assert.equal(await q.drain(10), true);
  });
});
