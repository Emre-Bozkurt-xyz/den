import { defineConfig } from 'drizzle-kit';

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
