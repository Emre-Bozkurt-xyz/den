/**
 * Server entry point. Builds the Fastify app, attaches socket.io to the same
 * HTTP server, listens, and shuts down cleanly.
 */
import { buildApp } from './app.js';
import { attachWs } from './ws.js';
import { env } from './env.js';
import { closeDb } from './db/index.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // socket.io shares Fastify's underlying HTTP server; routes reach it via
  // the `app.io` decorator (see ws.ts).
  attachWs(app);

  await app.listen({ host: env.host, port: env.port });
  app.log.info(`Den API on http://${env.host}:${env.port} (${env.nodeEnv})`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    app.io.close();
    await app.close();
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
