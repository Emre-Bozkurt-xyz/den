/**
 * Server entry point. Builds the Fastify app, attaches socket.io to the same
 * HTTP server, listens, and shuts down cleanly.
 */
import { buildApp } from './app.js';
import { attachWs } from './ws.js';
import { env, vaultLinkingEnabled } from './env.js';
import { closeDb } from './db/index.js';
import { drainMediaJobs } from './media/pipeline.js';
import { startMediaSweeper, stopMediaSweeper } from './media/sweeper.js';

/** How long shutdown waits for in-flight media jobs before closing the DB. */
const SHUTDOWN_DRAIN_MS = 30_000;

async function main(): Promise<void> {
  const app = await buildApp();

  // Backstop, not a strategy: much of the media/push/embed work is
  // fire-and-forget (`void promise`), and since Node 15 one rejection nobody
  // attached a handler to kills the whole process — every connected socket
  // and every in-flight transcode with it. Log it loudly and keep serving;
  // the fix for whatever shows up here is a `.catch` at its source.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection (process kept alive)');
  });

  // socket.io shares Fastify's underlying HTTP server; routes reach it via
  // the `app.io` decorator (see ws.ts).
  attachWs(app);

  await app.listen({ host: env.host, port: env.port });
  app.log.info(`Den API on http://${env.host}:${env.port} (${env.nodeEnv})`);

  // Degraded-capability warnings. These are deliberately NOT fatal — an
  // optional integration must never stop Den from booting (that regression
  // cost a prod deploy once; see docs/EMBEDS.md). But an operator who thinks
  // they configured Vault deserves to be told plainly that they didn't.
  if (!vaultLinkingEnabled) {
    const missing = [
      !env.vaultTokenEncKey && 'VAULT_TOKEN_ENC_KEY (generate: `openssl rand -hex 32`)',
      !env.vaultClientId &&
        `VAULT_CLIENT_ID (register Den at ${env.vaultIssuer}/oauth/register, then use the returned mcp_… id)`,
    ].filter(Boolean);
    app.log.warn(
      `Vault account linking is DISABLED — missing ${missing.join(' and ')}. ` +
        '/integrations/vault/connect returns 503 and the chat Stage reports every ' +
        'viewer as unlinked. See .env.example.',
    );
  } else if (!env.vaultServiceToken) {
    app.log.warn(
      'VAULT_SERVICE_TOKEN is not set — the chat Stage is READ-ONLY (no group ' +
        'creation, no doc create/clone). Mint one with Vault\'s scripts/seed-service.mjs.',
    );
  }

  // Recovers media stuck in 'processing' after a restart and discards
  // abandoned uploads (media/sweeper.ts). First sweep ~1 min after boot.
  startMediaSweeper(app.io, app.log);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // a second SIGTERM/SIGINT must not race the first
    shuttingDown = true;
    app.log.info(`${signal} received — shutting down`);

    // Order matters. Stop starting media work FIRST — drainMediaJobs closes
    // the queue synchronously, so a complete request still finishing inside
    // app.close() below can't start a job that would outlive the DB pool —
    // then stop taking requests, then give running transcodes a bounded
    // window to land before the pool goes away. Anything cut off stays
    // 'processing' and the sweeper recovers it on the next boot.
    // ⚠️ The 30s window only helps if the container is given longer than
    // that to stop: Docker's default is 10s before SIGKILL.
    const deadline = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SHUTDOWN_DRAIN_MS).unref());
    const mediaDrained = drainMediaJobs(SHUTDOWN_DRAIN_MS);
    const sweeperStopped = stopMediaSweeper();
    // Not awaited (unchanged ordering): io.close() resolves only once the
    // shared HTTP server has closed, which app.close() below does.
    void app.io.close().catch((err: unknown) => app.log.warn({ err }, 'socket.io close failed'));
    await app.close();
    const [drained, sweeper] = await Promise.all([mediaDrained, Promise.race([sweeperStopped.then(() => 'ok' as const), deadline])]);
    if (!drained) app.log.warn('media jobs still running at shutdown — left in processing for the sweeper');
    if (sweeper === 'timeout') app.log.warn('media sweep still running at shutdown');
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
