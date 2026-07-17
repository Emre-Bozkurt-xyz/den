import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// So `npm run db:migrate` / `db:generate` pick up the root .env locally
// (drizzle-kit loads this config in isolation, so it can't import our helper —
// keep this inline and in sync with server/src/env-file.ts). No-op in Docker.
if (!process.env.DATABASE_URL) {
  for (const rel of ['.env', '../.env', '../../.env']) {
    const abs = resolve(process.cwd(), rel);
    if (existsSync(abs)) {
      process.loadEnvFile(abs);
      break;
    }
  }
}

// Migrations land in server/drizzle/ from Stage 1 onward. Stage 0 has no
// domain schema, so `db:generate` produces nothing yet — that's expected.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://den:den@localhost:5432/den',
  },
  strict: true,
  verbose: true,
});
