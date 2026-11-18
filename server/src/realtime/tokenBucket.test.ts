/**
 * Unit tests for the inbound-frame token bucket (ws.ts). Pure, clock injected.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TokenBucket } from './tokenBucket.js';

describe('TokenBucket', () => {
  test('allows a full burst up to capacity, then refuses', () => {
    const b = new TokenBucket(5, 1, 0);
    for (let i = 0; i < 5; i++) assert.equal(b.take(0), true, `take #${i + 1}`);
    assert.equal(b.take(0), false);
  });

  test('refills at the configured rate', () => {
    const b = new TokenBucket(2, 2, 0); // 2 tokens/s
    assert.equal(b.take(0), true);
    assert.equal(b.take(0), true);
    assert.equal(b.take(0), false);
    assert.equal(b.take(250), false); // 0.5 token — not enough
    assert.equal(b.take(500), true); // 1 token accrued by now
    assert.equal(b.take(500), false);
  });

  test('never accrues past capacity, however long it idles', () => {
    const b = new TokenBucket(3, 10, 0);
    for (let i = 0; i < 3; i++) b.take(0);
    // An hour idle must not bank an hour's worth of frames.
    const later = 60 * 60 * 1000;
    for (let i = 0; i < 3; i++) assert.equal(b.take(later), true);
    assert.equal(b.take(later), false);
  });

  test('a refused take spends nothing', () => {
    const b = new TokenBucket(1, 1, 0);
    assert.equal(b.take(0), true);
    // Hammering an empty bucket must not push it into debt.
    for (let i = 0; i < 100; i++) assert.equal(b.take(0), false);
    assert.equal(b.take(1000), true);
  });

  test('a clock stepping backwards neither mints tokens nor wedges the bucket', () => {
    const b = new TokenBucket(1, 1, 10_000);
    assert.equal(b.take(10_000), true);
    assert.equal(b.take(5_000), false); // stepped back: no free token
    assert.equal(b.take(6_000), true); // and time still flows from the new reading
  });
});
