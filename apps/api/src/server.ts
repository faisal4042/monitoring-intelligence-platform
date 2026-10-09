import { config, collectionMode } from '@mip/config';
import { logger } from '@mip/logger';
import { sql } from '@mip/db';

import { buildApp } from './app.js';
import { ensureAutomaticQueries, startCollectionWorker } from './workers/collection.worker.js';
import { startClassificationWorker } from './workers/classification.worker.js';
import { startPartitionMaintenanceWorker } from './workers/partition-maintenance.worker.js';
import { startQueueIntakeWorker } from './workers/queue-intake.worker.js';
import { startWorkforceWorker } from './workers/workforce.worker.js';
import { startQueueWorkers } from './workers/start-queue-workers.js';
import { startNewsFetchWorker } from './workers/news-fetch.worker.js';
import { startAlertsWorker } from './workers/alerts.worker.js';
import { startXStreamWorker } from './workers/x-stream.worker.js';

let stopCollectionWorker: (() => void) | null = null;
let stopClassificationWorker: (() => void) | null = null;
let stopNewsFetchWorker: (() => void) | null = null;
let stopAlertsWorker: (() => void) | null = null;
let stopPartitionWorker: (() => void) | null = null;
let stopQueueIntake: (() => void) | null = null;
let stopWorkforce: (() => void) | null = null;
let stopXStreamWorker: (() => void) | null = null;

const app = await buildApp({ loggerInstance: logger });

async function main() {
  await app.listen({ port: config.API_PORT, host: '0.0.0.0' });

  // Before any worker can insert: monthly partitions must cover now and ahead.
  stopPartitionWorker = await startPartitionMaintenanceWorker();
  const queueWorkers = startQueueWorkers(config, {
    queue: startQueueIntakeWorker,
    workforce: startWorkforceWorker,
  });
  stopQueueIntake = queueWorkers.queue;
  stopWorkforce = queueWorkers.workforce;
  logger.info({ queue: config.QUEUE_WORKER_ENABLED, workforce: config.WORKFORCE_WORKER_ENABLED }, 'queue background worker gates');

  const automaticQueries = await ensureAutomaticQueries();
  stopCollectionWorker = startCollectionWorker();
  stopXStreamWorker = startXStreamWorker();
  stopClassificationWorker = startClassificationWorker();
  stopNewsFetchWorker = startNewsFetchWorker();
  stopAlertsWorker = startAlertsWorker();

  const banner =
    collectionMode === 'demo'
      ? 'DEMO MODE — no connection to the X API is possible (LIVE_X_API=false)'
      : collectionMode === 'dry_run'
        ? 'DRY RUN — queries are compiled and budgeted but never sent'
        : 'LIVE — real X API calls will be made and real quota consumed';

  logger.info(`API ready on :${config.API_PORT}`);
  logger.info(banner);
  logger.info({ automaticQueries }, 'automatic dictionary queries ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    logger.info('shutting down');
    stopCollectionWorker?.();
    stopXStreamWorker?.();
    stopClassificationWorker?.();
    stopNewsFetchWorker?.();
    stopAlertsWorker?.();
    stopPartitionWorker?.();
    stopQueueIntake?.();
    stopWorkforce?.();
    await app.close();
    await sql.end({ timeout: 5 }).catch(() => {});
    process.exit(0);
  });
}
