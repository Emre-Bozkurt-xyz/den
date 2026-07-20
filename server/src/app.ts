/**
 * Fastify application factory. Builds the HTTP app: plugins, the LOCKED error
 * envelope, and route registration. The HTTP server + socket.io are attached in
 * server.ts so tests can build the app without opening a socket.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ErrorCode, type ApiError } from '@den/shared';
import { env } from './env.js';
import { AppError } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { friendRoutes } from './routes/friends.js';
import { chatRoutes } from './routes/chats.js';
import { pushRoutes } from './routes/push.js';
import { mediaRoutes } from './routes/media.js';
import { galleryRoutes } from './routes/gallery.js';
import { voicePocRoutes } from './routes/voice-poc.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.isProd
      ? true
      : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } },
    // We serialize BIGINT ids as strings in DTOs, but bump the body limit for
    // the voice PoC's small uploads. Media proper never transits here (§ hard
    // invariant 2) — this limit only guards the throwaway PoC endpoint.
    bodyLimit: 30 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(rateLimit, {
    global: false, // opt-in per-route (auth routes get it in Stage 1)
    max: 100,
    timeWindow: '1 minute',
  });

  // ─── LOCKED error envelope ────────────────────────────────────────────────
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof AppError) {
      const body: ApiError = { error: { code: err.code, message: err.message } };
      return reply.status(err.statusCode).send(body);
    }
    // Fastify validation / rate-limit errors carry a statusCode.
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      const code = err.statusCode === 429 ? ErrorCode.RateLimited : ErrorCode.Validation;
      const body: ApiError = { error: { code, message: err.message } };
      return reply.status(err.statusCode).send(body);
    }
    req.log.error({ err }, 'unhandled error');
    const body: ApiError = { error: { code: ErrorCode.Internal, message: 'Internal error' } };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((_req, reply) => {
    const body: ApiError = { error: { code: ErrorCode.NotFound, message: 'Not found' } };
    return reply.status(404).send(body);
  });

  // ─── routes ───────────────────────────────────────────────────────────────
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(friendRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(pushRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api' });
  await app.register(galleryRoutes, { prefix: '/api' });
  await app.register(voicePocRoutes, { prefix: '/api' });

  return app;
}
