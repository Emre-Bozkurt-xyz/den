import { test, describe, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatchdog } from './stallWatchdog';

/**
 * The presigned PUT's hang guard (lib/media.ts `putWithProgress`). The
 * property that matters: it's an IDLE timer — a long upload that keeps
 * reporting progress must never be cut off, only one that stops moving.
 */
describe('stall watchdog', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  test('fires once the window passes with no kick', () => {
    let stalls = 0;
    const w = createStallWatchdog(() => stalls++);
    w.kick(30_000);
    mock.timers.tick(29_999);
    assert.equal(stalls, 0);
    mock.timers.tick(1);
    assert.equal(stalls, 1);
  });

  test('progress keeps a long upload alive indefinitely (not a total cap)', () => {
    let stalls = 0;
    const w = createStallWatchdog(() => stalls++);
    w.kick(30_000);
    // Ten minutes of slow-but-steady progress, an event every 20s.
    for (let i = 0; i < 30; i++) {
      mock.timers.tick(20_000);
      w.kick(30_000);
    }
    assert.equal(stalls, 0);
    mock.timers.tick(30_000);
    assert.equal(stalls, 1);
  });

  test('the last kick sets the window (longer response wait after body sent)', () => {
    let stalls = 0;
    const w = createStallWatchdog(() => stalls++);
    w.kick(30_000);
    mock.timers.tick(10_000);
    w.kick(90_000); // upload.onload
    mock.timers.tick(60_000);
    assert.equal(stalls, 0, 'the 30s window must not survive the switch to 90s');
    mock.timers.tick(30_000);
    assert.equal(stalls, 1);
  });

  test('stop disarms for good, and it never fires twice', () => {
    let stalls = 0;
    const w = createStallWatchdog(() => stalls++);
    w.kick(1_000);
    w.stop();
    w.kick(1_000); // a progress event racing the settle
    mock.timers.tick(10_000);
    assert.equal(stalls, 0);

    const w2 = createStallWatchdog(() => stalls++);
    w2.kick(1_000);
    mock.timers.tick(1_000);
    w2.kick(1_000); // late event after the stall abort
    mock.timers.tick(10_000);
    assert.equal(stalls, 1);
  });
});
