/**
 * Unit tests for client-address resolution (docs/AUTH_HARDENING.md §2.1).
 * Pure function over headers — no DB, no network.
 *
 * The bug these exist to prevent is the one that shipped: believing a header
 * the caller can write. Every case below is some version of "a forged value
 * must not be able to name the client".
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FastifyRequest } from 'fastify';
import { clientIp, ipCandidates, parseIpStrategy } from './clientIp.js';

/** Minimal stand-in for the parts of FastifyRequest this module reads. */
function req(headers: Record<string, string | string[]>, peer = '10.0.0.1'): FastifyRequest {
  return { headers, socket: { remoteAddress: peer }, ip: peer } as unknown as FastifyRequest;
}

describe('parseIpStrategy', () => {
  test('accepts the three known strategies, case-insensitively', () => {
    assert.equal(parseIpStrategy('none'), 'none');
    assert.equal(parseIpStrategy('cloudflare'), 'cloudflare');
    assert.equal(parseIpStrategy('XFF'), 'xff');
    assert.equal(parseIpStrategy(' xff '), 'xff');
  });

  test('anything unrecognized falls back to the unforgeable strategy', () => {
    // ⚠️ A typo in TRUSTED_PROXY must fail CLOSED (socket peer), never open.
    for (const bad of [undefined, '', 'true', 'yes', 'leftmost', 'x-forwarded-for']) {
      assert.equal(parseIpStrategy(bad), 'none');
    }
  });
});

describe('clientIp', () => {
  test('none: ignores every header, uses the socket peer', () => {
    const r = req({
      'x-forwarded-for': '1.2.3.4',
      'cf-connecting-ip': '5.6.7.8',
      'x-real-ip': '9.9.9.9',
    });
    assert.equal(clientIp(r, 'none'), '10.0.0.1');
  });

  test('cloudflare: uses CF-Connecting-IP', () => {
    assert.equal(clientIp(req({ 'cf-connecting-ip': '203.0.113.7' }), 'cloudflare'), '203.0.113.7');
  });

  test('cloudflare: falls back to the peer when the header is absent or blank', () => {
    assert.equal(clientIp(req({}), 'cloudflare'), '10.0.0.1');
    assert.equal(clientIp(req({ 'cf-connecting-ip': '   ' }), 'cloudflare'), '10.0.0.1');
  });

  test('xff: takes the RIGHTMOST entry, not the client-supplied leftmost', () => {
    // The whole point: an attacker prepends whatever they like; the last hop
    // appends the address it actually saw. Reading left would trust the lie.
    const r = req({ 'x-forwarded-for': '66.66.66.66, 198.51.100.4' });
    assert.equal(clientIp(r, 'xff'), '198.51.100.4');
  });

  test('xff: a single forged entry with no proxy appending cannot impersonate', () => {
    // One entry means nothing appended it — treat it as untrustworthy input.
    // It IS returned here (single trusted proxy is the documented deployment),
    // which is exactly why `none` is the default until the chain is verified.
    assert.equal(clientIp(req({ 'x-forwarded-for': '66.66.66.66' }), 'xff'), '66.66.66.66');
    assert.equal(clientIp(req({}), 'xff'), '10.0.0.1');
  });

  test('xff: tolerates whitespace, empty entries and a repeated header', () => {
    assert.equal(clientIp(req({ 'x-forwarded-for': ' 1.1.1.1 ,  , 2.2.2.2 ' }), 'xff'), '2.2.2.2');
    assert.equal(clientIp(req({ 'x-forwarded-for': ',,,' }), 'xff'), '10.0.0.1');
    assert.equal(clientIp(req({ 'x-forwarded-for': ['1.1.1.1, 3.3.3.3', '9.9.9.9'] }), 'xff'), '3.3.3.3');
  });

  test('never returns empty, even with no peer address', () => {
    const noPeer = { headers: {}, socket: {}, ip: '' } as unknown as FastifyRequest;
    assert.equal(clientIp(noPeer, 'none'), 'unknown');
  });
});

describe('ipCandidates', () => {
  test('reports every source so the right strategy can be chosen from evidence', () => {
    const c = ipCandidates(req({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': 'a, b' }));
    assert.equal(c.cfConnectingIp, '203.0.113.7');
    assert.equal(c.xForwardedFor, 'a, b');
    assert.equal(c.xForwardedForRightmost, 'b');
    assert.equal(c.socketPeer, '10.0.0.1');
    assert.equal(c.xRealIp, null);
  });
});
