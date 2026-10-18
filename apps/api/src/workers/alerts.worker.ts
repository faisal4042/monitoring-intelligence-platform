import {workerCheckpoint} from '../startup/worker-ownership.js';
import {trackedTask} from './tracked-task.js';
import {managedLoop, type WorkerStop} from './managed-loop.js';
/** Periodically evaluates active alert rules against recently-collected posts and rising stories. */
import { config } from '@mip/config';
import { alertLogger as log } from '@mip/logger';
import { evaluateRules } from '../modules/notify/service.js';

let ticking = false;

function tick() { return trackedTask('alerts',runTick); }
async function runTick() {
  await workerCheckpoint();
  if (ticking) return;
  ticking = true;
  try {
    // A window a bit wider than the tick interval covers the gap between
    // "post collected" and "this tick runs" without relying on exact timing.
    const result = await evaluateRules(config.ALERTS_TICK_SECONDS * 2);
    if (result.sent > 0) log.info(result, 'alert tick sent notifications');
  } catch (error) {
    log.error({ err: error instanceof Error ? error.message : String(error) }, 'alert tick failed');
  } finally {
    ticking = false;
  }
}

export function startAlertsWorker(options: { transitional?: boolean } = {}): WorkerStop {
  if (!config.ALERTS_ENABLED) {
    log.info('alert evaluation is disabled');
    return async () => {};
  }
  return managedLoop('alerts',tick,error=>log.error({err:error},'alerts loop failed'),config.ALERTS_TICK_SECONDS*1000,!options.transitional).stop;
}
