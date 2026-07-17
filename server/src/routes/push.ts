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
import { requireAuth } from '../auth/session.js';

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
  app.post('/push/test', { preHandler: requireAuth }, async (req, reply) => {
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

    const results = await Promise.allSettled(
      subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)),
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
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, subs[i]!.endpoint));
        }
        req.log.warn({ code }, 'push test: send failed');
      }),
    );

    return { ok: true, delivered, total: results.length };
  });
}
