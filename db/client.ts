/**
 * Postgres + Drizzle client (singleton, hot-reload-safe).
 * Requires DATABASE_URL. Used by the server data layer, auth, and metering.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set (SaaS branch requires Postgres)');
}

function createDb() {
  // prepare:false — better compatibility with serverless / pooled connections.
  const queryClient = postgres(databaseUrl!, { max: 10, prepare: false });
  return drizzle(queryClient, { schema });
}

type DB = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as { __openmaic_db?: DB };

export const db: DB = globalForDb.__openmaic_db ?? createDb();
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__openmaic_db = db;
}

export type { DB };
export { schema };
