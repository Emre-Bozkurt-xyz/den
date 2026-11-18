/**
 * Unit tests for the same-site forgery guard (auth/originCheck.ts). Pure.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isSafeMethod, originAllowed } from './originCheck.js';

const prod = { isProd: true, publicOrigin: 'https://den.example.com' };
const dev = { isProd: false, publicOrigin: 'http://localhost:5173' };

describe('originAllowed', () => {
  test('production: the app’s own origin is allowed', () => {
    assert.equal(originAllowed('https://den.example.com', prod), true);
  });

  test('production: PUBLIC_ORIGIN with a trailing slash or path still canonicalizes', () => {
    assert.equal(originAllowed('https://den.example.com', { isProd: true, publicOrigin: 'https://den.example.com/' }), true);
  });

  test('production: a sibling subdomain is refused — the case SameSite=Lax misses', () => {
    assert.equal(originAllowed('https://evil.example.com', prod), false);
    assert.equal(originAllowed('https://example.com', prod), false);
  });

  test('production: scheme and port are part of the origin', () => {
    assert.equal(originAllowed('http://den.example.com', prod), false);
    assert.equal(originAllowed('https://den.example.com:8443', prod), false);
  });

  test('production: lookalikes and the opaque origin are refused', () => {
    assert.equal(originAllowed('https://den.example.com.attacker.net', prod), false);
    assert.equal(originAllowed('null', prod), false);
    assert.equal(originAllowed('', prod), false);
    assert.equal(originAllowed(['https://den.example.com', 'https://evil.example.com'], prod), false);
  });

  test('no Origin header is allowed (CLI, probe scripts, Node socket.io-client)', () => {
    assert.equal(originAllowed(undefined, prod), true);
  });

  test('dev allows everything (Vite on :5173 proxying to :3000)', () => {
    assert.equal(originAllowed('http://localhost:5173', dev), true);
    assert.equal(originAllowed('http://localhost:3000', dev), true);
    assert.equal(originAllowed('https://anything.example', dev), true);
  });
});

describe('isSafeMethod', () => {
  test('only GET/HEAD/OPTIONS are exempt', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) assert.equal(isSafeMethod(m), true, m);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(isSafeMethod(m), false, m);
  });
});
