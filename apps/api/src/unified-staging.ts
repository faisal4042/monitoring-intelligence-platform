import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { installStagingNetworkGuard, installStagingRouteGuard } from './staging/safety.js';

loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
if (process.env.UNIFIED_STAGING !== 'true') throw new Error('Explicit UNIFIED_STAGING=true is required');
for (const flag of ['LIVE_X_API', 'X_DRY_RUN', 'AUTO_COLLECTION_ENABLED', 'X_STREAM_ENABLED',
  'AUTO_CLASSIFICATION_ENABLED', 'NEWS_FETCH_ENABLED', 'QUEUE_WORKER_ENABLED',
  'WORKFORCE_WORKER_ENABLED', 'ALERTS_ENABLED', 'NEWS_SCRAPLING_ENABLED', 'NEWS_SCRAPLING_DYNAMIC_ENABLED']) {
  if (process.env[flag] !== 'false') throw new Error(`Staging requires ${flag}=false`);
}
if (process.env.NEWS_SCRAPLING_SHADOW_MODE !== 'true') throw new Error('Staging requires Shadow mode');
const network = installStagingNetworkGuard();
const { buildApp } = await import('./app.js');
const app = await buildApp({ logger: false, configure: installStagingRouteGuard });
app.get('/api/staging/status', { config: { access: 'public' } }, async () => ({
  isolated: true, fixturesOnly: process.env.STAGING_DATA_MODE !== 'local_snapshot', dataMode: process.env.STAGING_DATA_MODE ?? 'fixtures', workers: 0, externalRequestsAllowed: false,
  scrapling: { live: false, shadow: true, executionEnabled: false }, network,
}));
await app.listen({ host: '127.0.0.1', port: 3003 });
console.log('Unified staging API: http://127.0.0.1:3003 — offline, no workers');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  await app.close();
  const { sql, analyticsSql } = await import('@mip/db');
  await Promise.all([sql.end(), analyticsSql.end()]);
  process.exit(0);
});
