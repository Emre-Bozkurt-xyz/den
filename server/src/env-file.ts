/**
 * Load the repo-root `.env` for LOCAL runs (tsx dev, drizzle-kit, CLI scripts).
 *
 * No-op when the environment is already populated — in Docker/production,
 * compose injects env vars directly and there is no `.env` file in the image, so
 * we must not depend on one. We only fall back to a file when DATABASE_URL is
 * absent, which is exactly the "someone ran a local command without --env-file"
 * case that bit us.
 *
 * cwd during `npm -w server run …` is the server/ dir, so the root file is
 * `../.env`; we also try `.env` and `../../.env` to be robust to how it's launched.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotenv(): void {
  if (process.env.DATABASE_URL) return; // already provided (compose, prod, or --env-file)
  for (const rel of ['.env', '../.env', '../../.env']) {
    const abs = resolve(process.cwd(), rel);
    if (existsSync(abs)) {
      process.loadEnvFile(abs);
      return;
    }
  }
}
