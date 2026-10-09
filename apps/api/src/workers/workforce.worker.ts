import { logger } from '@mip/logger';
import { runAssignmentPass, sweepStatuses } from '../modules/queue/workforce.js';

const log = logger.child({ subsystem: 'workforce' });

/**
 * Database-only, no network calls. Every 20 seconds:
 *  1. ends statuses of silent sessions and forgotten ends of shift (system policy),
 *  2. runs one automatic-assignment pass — a no-op while queue.auto_assign_enabled
 *     is false. This is the recovery path for any trigger that failed after its
 *     own transaction committed, and for a worker that died mid-pass (rolled back).
 */
export function startWorkforceWorker() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const swept = await sweepStatuses();
      if (swept.ended) log.info({ event: 'workforce_sweep', ...swept }, 'ended silent or overlong statuses');
      const pass = await runAssignmentPass({ trigger: 'periodic' });
      if (pass.assigned.length) log.info({ event: 'queue_auto_assign', trigger: 'periodic', assigned: pass.assigned.length }, 'items auto-assigned');
    } catch (err) {
      log.error({ err, event: 'workforce_worker_failed' }, 'workforce pass failed');
    } finally {
      running = false;
    }
  }, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}
