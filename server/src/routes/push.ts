/**
 * Push PoC (Stage 0 GO/NO-GO gate — BACKBONE §14).
 *
 * Purpose: prove Web Push works end-to-end on a real iPhone (installed PWA,
 * iOS ≥ 16.4). This is throwaway PoC wiring:
 *   - subscriptions live IN MEMORY, not in Postgres. The real
 *     `push_subscriptions` table + membership-scoped fanout is Stage 2 work.
 *   - a manual /test endpoint stands in for "a message arrived".
 *
 * Do not build on top of this; the real push path replaces it.
 */
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import type { PushConfigResponse, PushSubscribeRequest } from '@den/shared';
import { env } from '../env.js';
import { validation } from '../errors.js';

// In-memory PoC store (endpoint → subscription). Cleared on restart.
const subs = new Map<string, webpush.PushSubscription>();

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

  app.post('/push/subscribe', async (req) => {
    const b = req.body as Partial<PushSubscribeRequest> | undefined;
    if (!b?.endpoint || !b.keys?.p256dh || !b.keys?.auth) {
      throw validation('Malformed push subscription');
    }
    subs.set(b.endpoint, {
      endpoint: b.endpoint,
      keys: { p256dh: b.keys.p256dh, auth: b.keys.auth },
    });
    req.log.info({ count: subs.size }, 'push PoC: subscription stored');
    return { ok: true, count: subs.size };
  });

  // Manual trigger — stands in for "a new message landed".
  app.post('/push/test', async (req, reply) => {
    if (!ensureVapid()) {
      return reply.status(503).send({
        error: { code: 'internal', message: 'VAPID not configured — run npm run vapid:gen' },
      });
    }
    if (subs.size === 0) {
      throw validation('No subscriptions yet — tap "Enable notifications" on a device first');
    }
    const payload = JSON.stringify({
      chatName: 'Den',
      senderName: 'Push PoC',
      preview: 'If you can read this, iOS Web Push works. 🎉',
      // Deep-link target for notificationclick.
      url: '/',
    });

    const results = await Promise.allSettled(
      [...subs.values()].map((s) => webpush.sendNotification(s, payload)),
    );

    let delivered = 0;
    results.forEach((r, i) => {
      const endpoint = [...subs.keys()][i]!;
      if (r.status === 'fulfilled') {
        delivered++;
      } else {
        // ⚠️ prune on 404/410 — iOS reinstalls churn subscriptions (BACKBONE §5).
        const code = (r.reason as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) subs.delete(endpoint);
        req.log.warn({ code }, 'push PoC: send failed');
      }
    });

    return { ok: true, delivered, total: results.length };
  });
}
