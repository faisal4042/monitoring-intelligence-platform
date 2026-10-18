import {randomUUID} from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '@mip/config';
import * as schema from './schema.js';

export const processWorkerOwnerId=randomUUID();
export const sql = postgres(config.DATABASE_URL, {
  connection: {'mip.worker_owner':processWorkerOwnerId},
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
  connection: { jit: 'off', application_name: 'mip-analytics','mip.worker_owner':processWorkerOwnerId },
});

export const db = drizzle(sql, { schema });
/** Dedicated lease transport: business pools are never used as the lease owner. */
export function createWorkerLeaseClient(onclose: () => void, socket?: () => Promise<import('node:net').Socket>, ownerId:string=processWorkerOwnerId) {
  return postgres(config.DATABASE_URL, {
    max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 2,
    onnotice: () => {}, onclose,
    connection: {application_name: 'mip-worker-lease','mip.worker_owner':ownerId},
    ...(socket ? {socket} : {}),
  });
}
export type Db = typeof db;
export type Transaction = postgres.TransactionSql;

/** Fixture actors only; application pools use a fixed process UUID and never refresh it. */
export function createFixtureWorkerSql(ownerId:string) {
 const u=new URL(config.DATABASE_URL);
 if(process.env.NODE_ENV!=='test'||u.hostname!=='127.0.0.1'||u.port!=='5453'||!['/mip_cursor_startup_pre_test','/mip_cursor_startup_post_test'].includes(u.pathname))throw new Error('Fixture actor only');
 return postgres(config.DATABASE_URL,{max:6,idle_timeout:0,onnotice:()=>{},connection:{'mip.worker_owner':ownerId,application_name:'mip-fence-test-actor'}});
}
export function createFixtureWorkerDb(ownerId:string) {
 const client=createFixtureWorkerSql(ownerId);return {client,db:drizzle(client,{schema})};
}
export {sql as drizzleSql} from 'drizzle-orm';
