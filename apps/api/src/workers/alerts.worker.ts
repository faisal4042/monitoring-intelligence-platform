/** Periodically evaluates active alert rules against recently-collected posts and rising stories. */
import { config } from '@mip/config';
import { alertLogger as log } from '@mip/logger';
import { evaluateRules } from '../modules/notify/service.js';

let ticking = false;

async function tick() {
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

export function startAlertsWorker(): () => void {
  if (!config.ALERTS_ENABLED) {
    log.info('alert evaluation is disabled');
    return () => {};
  }
  const timer = setInterval(() => void tick(), config.ALERTS_TICK_SECONDS * 1000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
