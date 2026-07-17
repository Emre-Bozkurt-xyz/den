import type { FastifyInstance } from 'fastify';
import { ping } from '../db/index.js';

/** Liveness + DB-reachability probe. Used by Docker healthcheck and humans. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await ping();
      return { ok: true, db: 'up', ts: Date.now() };
    } catch {
      return reply.status(503).send({ ok: false, db: 'down', ts: Date.now() });
    }
  });
}
