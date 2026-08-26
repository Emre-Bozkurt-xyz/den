/**
 * Unit tests for the login lock's backoff curve (docs/AUTH_HARDENING.md §2.2).
 * `lockDurationMs` is the pure part; the DB-backed paths are exercised by
 * scripts/probe-auth-throttle.ts against a live stack.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LoginThrottle } from '@den/shared';
import { lockDurationMs } from './throttle.js';

describe('lockDurationMs', () => {
  test('the first lock is the base duration', () => {
    assert.equal(lockDurationMs(LoginThrottle.threshold), LoginThrottle.baseLockMs);
  });

  test('doubles per failure past the threshold', () => {
    assert.equal(lockDurationMs(LoginThrottle.threshold + 1), LoginThrottle.baseLockMs * 2);
    assert.equal(lockDurationMs(LoginThrottle.threshold + 2), LoginThrottle.baseLockMs * 4);
    assert.equal(lockDurationMs(LoginThrottle.threshold + 3), LoginThrottle.baseLockMs * 8);
  });

  test('caps — a lock is annoying, never indefinite', () => {
    // ⚠️ The cap is what makes the lockout-DoS tradeoff acceptable. If this
    // ever grows unbounded, someone who knows a username can lock its owner
    // out forever, which is precisely the failure this design trades against.
    assert.equal(lockDurationMs(100), LoginThrottle.maxLockMs);
    assert.equal(lockDurationMs(10_000), LoginThrottle.maxLockMs);
    assert.ok(Number.isFinite(lockDurationMs(Number.MAX_SAFE_INTEGER)));
    assert.equal(lockDurationMs(Number.MAX_SAFE_INTEGER), LoginThrottle.maxLockMs);
  });

  test('below the threshold never produces a longer-than-base lock', () => {
    for (let n = 0; n <= LoginThrottle.threshold; n++) {
      assert.equal(lockDurationMs(n), LoginThrottle.baseLockMs);
    }
  });
});
