/**
 * Who is calling? (docs/AUTH_HARDENING.md §2.1)
 *
 * Den sits behind Cloudflare → VPS → frp tunnel → Caddy → Fastify, and as of
 * 2026-08-26 the real client address does **not** survive that chain: two
 * different real clients (v4 and v6 egress from the same machine) landed in
 * one shared rate-limit bucket, and a forged `X-Forwarded-For` changed
 * nothing. So `req.ip` is currently a constant.
 *
 * ⚠️ The old code said `trustProxy: true`, which means "believe the leftmost
 * X-Forwarded-For entry" — a value any client can write. That is only harmless
 * today because the header is being dropped upstream; if the tunnel config
 * ever starts forwarding XFF, trust-all silently turns every IP-keyed limit
 * into decoration. This module therefore refuses to guess: the source is
 * chosen by explicit config, and the default is the one that cannot be lied to.
 *
 * Nothing security-critical should be keyed on the result while the strategy
 * is `none` — that is exactly why the per-account throttle (auth/throttle.ts)
 * keys on the username instead.
 */
import type { FastifyRequest } from 'fastify';

export const IP_STRATEGIES = ['none', 'cloudflare', 'xff'] as const;
export type IpStrategy = (typeof IP_STRATEGIES)[number];

export function parseIpStrategy(raw: string | undefined): IpStrategy {
  const v = (raw ?? '').trim().toLowerCase();
  return (IP_STRATEGIES as readonly string[]).includes(v) ? (v as IpStrategy) : 'none';
}

function firstHeader(req: FastifyRequest, name: string): string | null {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

/**
 * The RIGHTMOST `X-Forwarded-For` entry, not the leftmost.
 *
 * The leftmost is whatever the original caller claimed and is forgeable; the
 * rightmost was appended by the last proxy to touch the request and is the
 * only entry that hop can vouch for. With exactly one trusted proxy in front,
 * that is the client. (With N proxies you'd want the Nth from the right —
 * add a depth setting the day a second one appears, rather than assuming.)
 */
function rightmostXff(req: FastifyRequest): string | null {
  const raw = firstHeader(req, 'x-forwarded-for');
  if (!raw) return null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/** The transport peer — never forgeable, but often just the proxy. */
function socketPeer(req: FastifyRequest): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Resolve the caller under `strategy`. Always returns something usable. */
export function clientIp(req: FastifyRequest, strategy: IpStrategy): string {
  switch (strategy) {
    case 'cloudflare':
      return firstHeader(req, 'cf-connecting-ip') ?? socketPeer(req);
    case 'xff':
      return rightmostXff(req) ?? socketPeer(req);
    case 'none':
    default:
      return socketPeer(req);
  }
}

/**
 * Everything we could have keyed on, for `GET /api/debug/client-ip` (§2.5).
 * Run it once from a phone on mobile data: whichever field shows that phone's
 * real address names the correct `TRUSTED_PROXY` value.
 */
export function ipCandidates(req: FastifyRequest): Record<string, string | null> {
  return {
    socketPeer: socketPeer(req),
    cfConnectingIp: firstHeader(req, 'cf-connecting-ip'),
    xForwardedFor: firstHeader(req, 'x-forwarded-for'),
    xForwardedForRightmost: rightmostXff(req),
    xRealIp: firstHeader(req, 'x-real-ip'),
    trueClientIp: firstHeader(req, 'true-client-ip'),
    forwarded: firstHeader(req, 'forwarded'),
    fastifyReqIp: req.ip,
  };
}
