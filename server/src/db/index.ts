/**
 * Postgres connection + Drizzle handle.
 *
 * Stage 0 ships the connection wiring and a `ping()` used by the health route
 * to prove DB reachability. The domain schema (migration 001: users,
 * auth_identities, chats, messages, media, tags, …) is Stage 1 work and is
 * intentionally NOT defined yet — see BACKBONE §14.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from '../env.js';

// One shared pool for the process.
export const pg = postgres(env.databaseUrl, {
  max: 10,
  // Fail a query rather than hang forever if PG is down.
  connect_timeout: 10,
});

export const db = drizzle(pg);

/** Lightweight liveness probe for /health. Throws if PG is unreachable. */
export async function ping(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

export async function closeDb(): Promise<void> {
  await pg.end({ timeout: 5 });
}
