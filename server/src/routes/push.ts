/**
 * Push subscription endpoints (BACKBONE §6, §8). Subscriptions persist per
 * user in `push_subscriptions`; delivery on real messages lives in
 * `push/notify.ts`. `/push/test` stays around as a debug tool (CLAUDE.md:
 * "keeping debugging easy for future testing") — it now only pushes to the
 * caller's own devices instead of every subscription on the server.
 */
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import type { PushConfigResponse, PushSubscribeRequest } from '@den/shared';
import { env } from '../env.js';
import { validation } from '../errors.js';
import { db } from '../db/index.js';
import { pushSubscriptions } from '../db/schema.js';
import { requireAuth, sessionRateKey } from '../auth/session.js';
import { PUSH_KEY_MAX, checkPushEndpoint } from '../push/endpoint.js';

let configured = false;
function ensureVapid(): boolean {
  if (configured) return true;
  if (!env.vapidPublicKey || !env.vapidPrivateKey) return false;
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
  configured = true;
  return true;
}

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  // Hand the client the public key so it can subscribe.
  app.get('/push/config', async (_req, reply) => {
    if (!env.vapidPublicKey) {
      return reply.status(503).send({
        error: { code: 'internal', message: 'VAPID not configured — run npm run vapid:gen' },
      });
    }
    const body: PushConfigResponse = { vapidPublicKey: env.vapidPublicKey };
    return body;
  });

  app.post('/push/subscribe', { preHandler: requireAuth }, async (req) => {
    const b = req.body as Partial<PushSubscribeRequest> | undefined;
    if (!b?.endpoint || !b.keys?.p256dh || !b.keys?.auth) {
      throw validation('Malformed push subscription');
    }
    if (
      typeof b.keys.p256dh !== 'string' ||
      typeof b.keys.auth !== 'string' ||
      b.keys.p256dh.length > PUSH_KEY_MAX ||
      b.keys.auth.length > PUSH_KEY_MAX
    ) {
      throw validation('Malformed push subscription');
    }
    // ⚠️ The server POSTs to whatever is stored here, so an unchecked endpoint
    // is a blind SSRF (push/endpoint.ts). The host is logged on refusal so a
    // real device on an unlisted push service shows up in the logs as
    // something to add to the allowlist, rather than silently never getting
    // notifications.
    const check = checkPushEndpoint(b.endpoint, env.isProd);
    if (!check.ok) {
      req.log.warn(
        { userId: req.user!.id.toString(), host: check.host, reason: check.reason },
        'push subscribe refused: endpoint failed validation',
      );
      throw validation('Unsupported push endpoint');
    }
    // A given browser subscription (endpoint) belongs to one user at a time —
    // re-subscribing (new login, same device) reassigns it.
    await db
      .insert(pushSubscriptions)
      .values({ userId: req.user!.id, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { userId: req.user!.id, p256dh: b.keys.p256dh, auth: b.keys.auth },
      });
    return { ok: true };
  });

  // Debug tool: push a test notification to the caller's own subscriptions.
  //
  // Tighter than the app-wide default (app.ts): every call is an outbound
  // request per device, and a buzzing phone is the cost. Keyed per session for
  // the same reason as that default — never per IP behind the proxy.
  app.post(
    '/push/test',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: '1 minute', keyGenerator: (r) => sessionRateKey(r) ?? 'no-session' } },
    },
    async (req, reply) => {
      if (!ensureVapid()) {
        return reply.status(503).send({
          error: { code: 'internal', message: 'VAPID not configured — run npm run vapid:gen' },
        });
      }
      const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, req.user!.id));
      if (subs.length === 0) {
        throw validation('No subscriptions yet — tap "Enable notifications" on a device first');
      }

      const payload = JSON.stringify({
        chatName: 'Den',
        senderName: 'Push test',
        preview: 'If you can read this, Web Push works. 🎉',
        url: '/',
      });

      // Same delivery hints as a real message (docs/NOTIFICATIONS.md §2.4) —
      // a debug tool that takes a friendlier path than production is a debug
      // tool that can't reproduce the bug. Same endpoint gate too: a row
      // stored before validation existed is never sent to unless it passes.
      const results = await Promise.allSettled(
        subs.map((s) => {
          const check = checkPushEndpoint(s.endpoint, env.isProd);
          if (!check.ok) {
            return Promise.reject(Object.assign(new Error(`endpoint refused: ${check.reason}`), { host: check.host }));
          }
          return webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: 60 * 60,
            urgency: 'high',
          });
        }),
      );

      let delivered = 0;
      await Promise.all(
        results.map(async (r, i) => {
          if (r.status === 'fulfilled') {
            delivered++;
            return;
          }
          // ⚠️ prune on 404/410 — iOS reinstalls churn subscriptions (BACKBONE §5).
          const code = (r.reason as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) {
            // A failed prune must not turn a debug report into a 500.
            await db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.endpoint, subs[i]!.endpoint))
              .catch((err) => req.log.error({ err }, 'push test: prune failed'));
          }
          req.log.warn(
            { code, host: (r.reason as { host?: string | null })?.host, err: (r.reason as Error)?.message },
            'push test: send failed',
          );
        }),
      );

      return { ok: true, delivered, total: results.length };
    },
  );
}
