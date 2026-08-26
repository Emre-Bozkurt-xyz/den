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
 * Requires a session — a stranger learns nothing, and a member only ever sees
 * the headers on their own request. Run it once from a phone on mobile data:
 * whichever field shows that phone's real address names the right
 * TRUSTED_PROXY value.
 */
import type { FastifyInstance } from 'fastify';
import { clientIp, ipCandidates } from '../auth/clientIp.js';
import { requireAuth } from '../auth/session.js';
import { env } from '../env.js';

export async function debugRoutes(app: FastifyInstance): Promise<void> {
  app.get('/debug/client-ip', { preHandler: requireAuth }, async (req) => {
    return {
      strategy: env.trustedProxy,
      trustProxy: env.trustProxy,
      resolved: clientIp(req, env.trustedProxy),
      candidates: ipCandidates(req),
    };
  });
}
