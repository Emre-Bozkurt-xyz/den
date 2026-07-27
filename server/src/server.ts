/**
 * Server entry point. Builds the Fastify app, attaches socket.io to the same
 * HTTP server, listens, and shuts down cleanly.
 */
import { buildApp } from './app.js';
import { attachWs } from './ws.js';
import { env, vaultLinkingEnabled } from './env.js';
import { closeDb } from './db/index.js';

async function main(): Promise<void> {
  const app = await buildApp();

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
    app.log.warn(
      'VAULT_TOKEN_ENC_KEY is not set — Vault account linking is DISABLED ' +
        '(/integrations/vault/connect returns 503, the chat Stage reports every ' +
        'viewer as unlinked). Generate one with `openssl rand -hex 32`; see .env.example.',
    );
  } else if (!env.vaultServiceToken) {
    app.log.warn(
      'VAULT_SERVICE_TOKEN is not set — the chat Stage is READ-ONLY (no group ' +
        'creation, no doc create/clone). Mint one with Vault\'s scripts/seed-service.mjs.',
    );
  }

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
