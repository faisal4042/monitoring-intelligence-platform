import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '@mip/config';
import * as schema from './schema.js';

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  onnotice: () => {},
});

/**
 * Read-only analytics (the dashboard's aggregates). A separate small pool
 * with JIT off: on these one-pass aggregates PostgreSQL's JIT compilation
 * costs more than it saves (measured ~0.5 s per query on 100k posts).
 * Nothing else uses it, so the rest of the platform keeps its settings.
 */
export const analyticsSql = postgres(config.DATABASE_URL, {
  max: 4,
  idle_timeout: 5,
  onnotice: () => {},
  connection: { jit: 'off', application_name: 'mip-analytics' },
});

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export type Transaction = postgres.TransactionSql;
