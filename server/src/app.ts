/**
 * Fastify application factory. Builds the HTTP app: plugins, the LOCKED error
 * envelope, and route registration. The HTTP server + socket.io are attached in
 * server.ts so tests can build the app without opening a socket.
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { ErrorCode, type ApiError } from '@den/shared';
import { env } from './env.js';
import { AppError, forbidden } from './errors.js';
import { clientIp } from './auth/clientIp.js';
import { isSafeMethod, originAllowed } from './auth/originCheck.js';
import { sessionRateKey } from './auth/session.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { passkeyRoutes } from './routes/passkeys.js';
import { friendRoutes } from './routes/friends.js';
import { chatRoutes } from './routes/chats.js';
import { pushRoutes } from './routes/push.js';
import { mediaRoutes } from './routes/media.js';
import { gifRoutes } from './routes/gifs.js';
import { galleryRoutes } from './routes/gallery.js';
import { integrationsVaultRoutes } from './routes/integrations-vault.js';
import { stageRoutes } from './routes/stage.js';
import { debugRoutes } from './routes/debug.js';
import { adminRoutes } from './routes/admin.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.isProd
      ? true
      : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } },
    // 1 MiB (Fastify's own default, stated explicitly). This was 30MB solely
    // for the Stage 0 voice PoC's direct uploads, and that route is gone —
    // it was unauthenticated, so anyone could make the server buffer ~25MB
    // and run ffmpeg over it. Media bytes never transit the API (hard
    // invariant 2), so every remaining body is small JSON: the largest are a
    // 4000-char message body (ChatLimits) and a WebAuthn response, both well
    // under this. A route that genuinely needs more should raise it per-route.
    bodyLimit: 1024 * 1024,
    // ⚠️ Was hardcoded `true`, which tells Fastify to read req.ip from the
    // LEFTMOST X-Forwarded-For entry — a value the caller writes. Every
    // IP-keyed limit in the app inherits that. Now opt-in via TRUST_PROXY,
    // and the auth paths resolve the client through auth/clientIp.ts with an
    // explicitly configured source instead (docs/AUTH_HARDENING.md §2.1).
    trustProxy: env.trustProxy,
  });

  await app.register(cookie, { secret: env.sessionSecret });

  // ─── same-site forgery guard (auth/originCheck.ts) ────────────────────────
  // SameSite=Lax lets a sibling-subdomain page send Den's cookie; a wrong
  // `Origin` on a state-changing request is refused here, before any route
  // runs. Production only, and requests with no Origin (CLI, probe scripts)
  // pass — see the module header for why both are safe.
  app.addHook('onRequest', async (req) => {
    if (isSafeMethod(req.method)) return;
    if (originAllowed(req.headers.origin, { isProd: env.isProd, publicOrigin: env.publicOrigin })) return;
    req.log.warn({ origin: req.headers.origin, method: req.method, url: req.url }, 'refused cross-origin request');
    throw forbidden('Cross-origin request refused');
  });

  await app.register(rateLimit, {
    // Per-route opt-in for the plugin's own hook: auth, passkey and re-auth
    // routes carry a `config.rateLimit` and are keyed per client below. The
    // default for everything else is the session-keyed hook just after this.
    global: false,
    max: 100,
    timeWindow: '1 minute',
    // Key on the explicitly-resolved client, not Fastify's req.ip. Under the
    // default `none` strategy this is the socket peer, which in prod is one
    // constant for everybody — so this limiter is a flood backstop only. The
    // per-account bound that actually stops credential guessing lives in
    // auth/throttle.ts (docs/AUTH_HARDENING.md §2.3).
    keyGenerator: (req) => clientIp(req, env.trustedProxy),
  });

  // ─── default limit for authenticated REST ─────────────────────────────────
  //
  // Before this, only the credential routes were limited, so a member — or a
  // stolen session — could hammer `/push/test`, friend requests, upload
  // mints or GIF search (each a DB write, an outbound fetch, or a push to
  // someone's phone) as fast as the socket allowed.
  //
  // ⚠️ Keyed per SESSION (`sessionRateKey`), never per IP: behind Caddy every
  // client may share one peer address, and an IP-keyed default would be one
  // bucket for the whole circle (docs/AUTH_HARDENING.md §1). Requests with no
  // session cookie are skipped — they can only reach unauthenticated routes,
  // which either carry their own per-client limit or are trivially cheap
  // (`/health`, `/push/config`). Routes WITH their own `config.rateLimit` are
  // skipped too, so the plugin's per-route limiter (which only ever runs once
  // per request) still gets them: the auth routes keep their exact existing
  // 120/min per-client behaviour, which is what the probe scripts measure.
  //
  // 600/min = 10 req/s sustained per session. Opening the app, a chat, the
  // gallery and scrolling history is a few dozen requests; nobody reaches
  // this by using Den.
  const authedDefaultLimit = app.rateLimit({
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (req) => sessionRateKey(req) ?? 'no-session',
  });
  app.addHook('onRequest', async function (req, reply) {
    if (req.routeOptions.config?.rateLimit !== undefined) return;
    if (sessionRateKey(req) === null) return;
    await authedDefaultLimit.call(this, req, reply);
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
  await app.register(passkeyRoutes, { prefix: '/api' });
  await app.register(friendRoutes, { prefix: '/api' });
  await app.register(chatRoutes, { prefix: '/api' });
  await app.register(pushRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api' });
  await app.register(galleryRoutes, { prefix: '/api' });
  await app.register(gifRoutes, { prefix: '/api' });
  await app.register(integrationsVaultRoutes, { prefix: '/api' });
  await app.register(stageRoutes, { prefix: '/api' });
  await app.register(debugRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });

  return app;
}
