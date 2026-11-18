/**
 * Diagnostics (docs/AUTH_HARDENING.md §2.5).
 *
 * Exists to settle one question that cannot be answered from outside: which
 * header, if any, carries the real client address by the time a request has
 * crossed Cloudflare → VPS → frp tunnel → Caddy → Fastify. Measurement from
 * the public side proved only that `req.ip` is a constant; it could not say
 * whether `CF-Connecting-IP` survives, and guessing is how the `trustProxy:
 * true` bug got written in the first place.
 *
 * Run it once from a phone on mobile data: whichever field shows that phone's
 * real address names the right TRUSTED_PROXY value.
 *
 * ⚠️ Owner-only in production (any session in dev). It used to accept any
 * member, on the reasoning that it only describes the caller's own request —
 * true, but it still hands every member a map of the proxy chain (which
 * headers survive, the internal gateway addresses in X-Forwarded-For, the
 * trust settings). That is operator knowledge, and the owner is the only one
 * who needs it to set TRUSTED_PROXY.
 */
import type { FastifyInstance } from 'fastify';
import { clientIp, ipCandidates } from '../auth/clientIp.js';
import { requireOwner } from '../auth/owner.js';
import { requireAuth } from '../auth/session.js';
import { env } from '../env.js';

export async function debugRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/client-ip', { preHandler: env.isProd ? requireOwner : requireAuth }, async (req) => {
    return {
      strategy: env.trustedProxy,
      trustProxy: env.trustProxy,
      resolved: clientIp(req, env.trustedProxy),
      candidates: ipCandidates(req),
    };
  });
}
