/**
 * Report export + schedule workers. Off unless REPORT_EXPORTS_ENABLED / REPORT_SCHEDULES_ENABLED, and idle while
 * migration 0047 is absent. Writes go through the same fencing lease as every worker (workerCheckpoint).
 * Read-only data access; no external provider is ever called.
 */
import {randomUUID} from 'node:crypto';
import {logger} from '@mip/logger';
import {managedLoop, type WorkerStop} from './managed-loop.js';
import {trackedTask} from './tracked-task.js';
import {claimNextExport, expireExports, exportsEnabled, reportsActivated, runExport, schedulesEnabled} from '../modules/reports/jobs.js';
import {runDueSchedules} from '../modules/reports/schedules.js';

const owner = randomUUID();
let lastExpiry = 0;
export async function exportPass() {
  // Defence in depth: server.ts only starts this loop when enabled, but the pass itself also refuses.
  if (!exportsEnabled() || !(await reportsActivated())) return {processed: 0};
  if (Date.now() - lastExpiry > 3600_000) { lastExpiry = Date.now(); await expireExports(); }
  let processed = 0;
  for (let i = 0; i < 3; i++) {
    const job = await claimNextExport(owner);
    if (!job) break;
    const result = await runExport(job, owner);
    logger.info({event: 'report_export', exportId: job.id, result, attempt: job.attempts}, 'report export pass');
    processed++;
  }
  return {processed};
}
export function startReportExportWorker(): WorkerStop {
  return managedLoop('report-exports', () => trackedTask('report-exports', async () => { await exportPass(); }),
    (err) => logger.error({err}, 'report export worker failed'), 5000).stop;
}
export function startReportScheduleWorker(): WorkerStop {
  return managedLoop('report-schedules', () => trackedTask('report-schedules', async () => {
    if (!schedulesEnabled() || !(await reportsActivated())) return;
    const runs = await runDueSchedules();
    if (runs.length) logger.info({event: 'report_schedules', runs}, 'report schedule pass');
  }), (err) => logger.error({err}, 'report schedule worker failed'), 60_000).stop;
}
