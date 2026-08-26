/**
 * Unit tests for the non-cryptographic half of WebAuthn (docs/PASSKEYS.md §5).
 * The ceremonies themselves are exercised against a live server by
 * `scripts/probe-passkey.ts`, which drives them with a real software
 * authenticator; these cover the pieces that are pure and easy to get subtly
 * wrong.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { defaultLabel, expectedOrigins, rpID } from './webauthn.js';

describe('rpID', () => {
  test('is the HOST only — no scheme, no port', () => {
    // ⚠️ The classic way to get this wrong is to pass the origin. An rpID with
    // a scheme or port is rejected by the browser, and the failure surfaces as
    // "passkeys just don't work" rather than anything pointing here.
    const id = rpID();
    assert.ok(!id.includes('://'), `rpID must not contain a scheme: ${id}`);
    assert.ok(!id.includes(':'), `rpID must not contain a port: ${id}`);
    assert.ok(!id.endsWith('/'), `rpID must not be a URL: ${id}`);
    assert.ok(id.length > 0);
  });
});

describe('expectedOrigins', () => {
  test('always includes the configured public origin, with its scheme', () => {
    const origins = expectedOrigins();
    assert.ok(origins.length > 0);
    for (const o of origins) {
      assert.ok(/^https?:\/\//.test(o), `expected a full origin, got ${o}`);
      assert.ok(!o.endsWith('/'), `origin must not have a trailing slash: ${o}`);
    }
  });

  test('has no duplicates', () => {
    const origins = expectedOrigins();
    assert.equal(new Set(origins).size, origins.length);
  });

  test('every entry is a site allowed to drive a ceremony', () => {
    // Not a behavioural assertion so much as a tripwire: this list is the set
    // of sites permitted to authenticate against Den's credentials, so a new
    // entry appearing here should be a deliberate, reviewed act.
    for (const o of expectedOrigins()) {
      const host = new URL(o).hostname;
      assert.ok(
        host === 'localhost' || host === rpID(),
        `unexpected origin in the allow list: ${o}`,
      );
    }
  });
});

describe('defaultLabel', () => {
  test('names the common platforms', () => {
    assert.equal(defaultLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'iPhone');
    assert.equal(defaultLabel('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'iPad');
    assert.equal(defaultLabel('Mozilla/5.0 (Linux; Android 14; SM-S911B)'), 'Android device');
    assert.equal(defaultLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac');
    assert.equal(defaultLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows PC');
  });

  test('iPad is not mislabelled as a Mac', () => {
    // iPadOS Safari reports a desktop-Mac UA in "Request Desktop Site" mode,
    // and the iPad branch must be tested before the Macintosh one for the
    // honest UA. This pins that ordering.
    assert.equal(defaultLabel('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Safari'), 'iPad');
  });

  test('always returns something usable', () => {
    assert.equal(defaultLabel(undefined), 'Passkey');
    assert.equal(defaultLabel(''), 'Passkey');
    assert.equal(defaultLabel('some-unknown-agent/1.0'), 'Passkey');
  });
});
