import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '@mip/config';
import * as schema from './schema.js';

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });
export type Db = typeof db;
