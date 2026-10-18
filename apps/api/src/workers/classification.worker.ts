import {workerCheckpoint} from '../startup/worker-ownership.js';
import {trackedTask} from './tracked-task.js';
import {managedLoop, type WorkerStop} from './managed-loop.js';
/**
 * Automatic تصنيف التفاعلات — runs the same batch the manual "تشغيل التصنيف"
 * button triggers, on a timer, so newly collected posts get embedded, matched
 * to a topic, and (if nothing matches) proposed as a new topic by the LLM
 * without anyone clicking anything.
 */
import { config } from '@mip/config';
import { aiLogger as log } from '@mip/logger';
import { runClassificationBatch } from '../modules/classification/service.js';
import { refreshSignalStories } from '../modules/signals/service.js';

let ticking = false;

function tick() { return trackedTask('classification',runTick); }
async function runTick() {
  await workerCheckpoint();
  if (ticking) return;
  ticking = true;
  try {
    try {
      const result = await runClassificationBatch({
        limit: config.AUTO_CLASSIFICATION_BATCH_SIZE,
        discoverTopics: true,
      });
      if (result.considered > 0) {
        log.info(result, 'automatic classification tick');
      }
    } catch (err) {
      log.error({ err }, 'automatic classification tick failed');
    }
    // Story clustering is local and must continue even if an external AI
    // provider is unavailable.
    try {
      await workerCheckpoint();
      await refreshSignalStories(config.AUTO_CLASSIFICATION_BATCH_SIZE * 10);
    } catch (err) {
      log.error({ err }, 'signal story refresh failed');
    }
  } finally {
    ticking = false;
  }
}

export function startClassificationWorker(options: { transitional?: boolean } = {}): WorkerStop {
  if (!config.AUTO_CLASSIFICATION_ENABLED) return async () => {};
  const loop=managedLoop('classification',tick,error=>log.error({err:error},'classification loop failed'),config.AUTO_CLASSIFICATION_TICK_SECONDS*1000,!options.transitional);
  return loop.stop;
}
