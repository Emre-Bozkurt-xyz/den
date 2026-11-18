/**
 * Unit tests for push endpoint validation (push/endpoint.ts). Pure — no DB.
 *
 * The bug these exist to prevent: a member storing an endpoint that makes
 * Den's server POST into its own private network (blind SSRF).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PUSH_ENDPOINT_MAX, checkPushEndpoint } from './endpoint.js';

const ok = (raw: string, enforce = true) => checkPushEndpoint(raw, enforce).ok;

describe('checkPushEndpoint — real push services', () => {
  test('accepts the endpoints real browsers hand out', () => {
    for (const e of [
      'https://fcm.googleapis.com/fcm/send/abc123:APA91bXYZ',
      'https://fcm.googleapis.com/wp/abc123',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://web.push.apple.com/QGx2m9Wk3a',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB',
      'https://FCM.googleapis.com/fcm/send/x', // hostnames are case-insensitive
      'https://fcm.googleapis.com:443/fcm/send/x', // explicit default port normalizes away
    ]) {
      assert.equal(ok(e), true, e);
    }
  });

  test('reports the host it accepted', () => {
    const r = checkPushEndpoint('https://web.push.apple.com/abc', true);
    assert.deepEqual(r, { ok: true, host: 'web.push.apple.com' });
  });
});

describe('checkPushEndpoint — SSRF shapes', () => {
  test('refuses non-https schemes', () => {
    for (const e of ['http://fcm.googleapis.com/fcm/send/x', 'ftp://fcm.googleapis.com/x', 'file:///etc/passwd', 'javascript:alert(1)']) {
      assert.equal(ok(e), false, e);
    }
  });

  test('refuses IP literals, including disguised IPv4 forms and IPv6', () => {
    for (const e of [
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://169.254.169.254/latest/meta-data',
      'https://2130706433/x', // decimal 127.0.0.1
      'https://0x7f000001/x', // hex 127.0.0.1
      'https://[::1]/x',
      'https://[fd00::1]/x',
    ]) {
      // Even with the allowlist OFF (dev) — that rule is structural.
      const r = checkPushEndpoint(e, false);
      assert.equal(r.ok, false, e);
      assert.equal(!r.ok && r.reason, 'IP literal host', e);
    }
  });

  test('refuses non-default ports and embedded credentials', () => {
    assert.equal(ok('https://fcm.googleapis.com:5432/x'), false);
    assert.equal(ok('https://user:pw@fcm.googleapis.com/x'), false);
    assert.equal(ok('https://user:pw@localhost:8443/x', false), false); // credentials: refused even in dev
  });

  test('refuses lookalike hosts that a naive suffix or substring match would let through', () => {
    for (const e of [
      'https://push.apple.com/x', // the bare suffix is not a subdomain of itself
      'https://notpush.apple.com/x',
      'https://web.push.apple.com.attacker.net/x',
      'https://fcm.googleapis.com.attacker.net/x',
      'https://evil-fcm.googleapis.com/x',
      'https://attacker.net/fcm.googleapis.com',
      'https://localhost/x',
      'https://db.internal/x',
    ]) {
      assert.equal(ok(e), false, e);
    }
  });

  test('refuses junk and over-long input', () => {
    assert.equal(ok(''), false);
    assert.equal(checkPushEndpoint(undefined, true).ok, false);
    assert.equal(checkPushEndpoint(42, true).ok, false);
    assert.equal(ok('not a url'), false);
    const long = 'https://fcm.googleapis.com/' + 'a'.repeat(PUSH_ENDPOINT_MAX);
    assert.equal(ok(long), false);
  });

  test('a rejected host is reported so the owner can extend the list', () => {
    const r = checkPushEndpoint('https://push.example-browser.com/abc', true);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.host, 'push.example-browser.com');
    assert.equal(!r.ok && r.reason, 'host not in push allowlist');
  });

  test('dev mode skips only the allowlist and the port rule', () => {
    // A local fake push service (docs/NOTIFICATIONS.md §9) must still work…
    assert.equal(ok('https://localhost/fake-push', false), true);
    assert.equal(ok('https://localhost:8443/fake-push', false), true);
    // …but the structural rules don't relax with it.
    assert.equal(ok('http://localhost/fake-push', false), false);
    assert.equal(ok('https://127.0.0.1:8443/fake-push', false), false);
  });
});
