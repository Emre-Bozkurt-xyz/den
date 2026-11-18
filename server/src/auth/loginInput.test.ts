/**
 * Unit tests for the login input shape check (auth/loginInput.ts). Pure.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AuthLimits } from '@den/shared';
import { loginInputPlausible } from './loginInput.js';

describe('loginInputPlausible', () => {
  test('a normal username + password passes', () => {
    assert.equal(loginInputPlausible('alice', 'correct horse battery'), true);
    assert.equal(loginInputPlausible('bob_2-x', 'x'.repeat(AuthLimits.passwordMax)), true);
  });

  test('over-long usernames are refused (they would be stored in login_failures)', () => {
    assert.equal(loginInputPlausible('a'.repeat(AuthLimits.usernameMax), 'pw'), true);
    assert.equal(loginInputPlausible('a'.repeat(AuthLimits.usernameMax + 1), 'pw'), false);
    assert.equal(loginInputPlausible('a'.repeat(100_000), 'pw'), false);
  });

  test('too-short and empty usernames are refused', () => {
    assert.equal(loginInputPlausible('', 'pw'), false);
    assert.equal(loginInputPlausible('ab', 'pw'), false);
  });

  test('usernames outside the registration charset are refused', () => {
    for (const u of ['al ice', 'alice!', 'ålice', "alice'--", 'alice\u0000', 'ALICE']) {
      // ALICE: callers lowercase first; an uppercase value here means they didn't.
      assert.equal(loginInputPlausible(u, 'pw'), false, JSON.stringify(u));
    }
  });

  test('over-long passwords are refused before argon2 ever sees them', () => {
    assert.equal(loginInputPlausible('alice', 'x'.repeat(AuthLimits.passwordMax + 1)), false);
    assert.equal(loginInputPlausible('alice', 'x'.repeat(1_000_000)), false);
  });

  test('short passwords are NOT refused here — a raised floor must not lock out old accounts', () => {
    assert.equal(loginInputPlausible('alice', ''), true);
    assert.equal(loginInputPlausible('alice', 'abc'), true);
  });
});
