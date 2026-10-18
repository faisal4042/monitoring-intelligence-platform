/**
 * X public post → ticket sweep. Off unless X_POST_TICKETS_ENABLED (and X_POST_TICKETS_SINCE set). Links posts saved in
 * the window whose inline link failed (collection.service links each saved post immediately; this only heals gaps).
 * Never calls X or any provider; writes go through the fencing lease like every worker (workerCheckpoint).
 */
import {logger} from '@mip/logger';
import {managedLoop, type WorkerStop} from './managed-loop.js';
import {trackedTask} from './tracked-task.js';
import {sweepUnlinkedXPosts} from '../modules/tickets/x-post-link.js';

export function startXPostTicketWorker(): WorkerStop {
  return managedLoop('x-post-tickets', () => trackedTask('x-post-tickets', async () => {
    const r = await sweepUnlinkedXPosts(200);
    if (r.scanned) logger.info({event: 'x_post_ticket_sweep', ...r}, 'x post ticket sweep');
  }), (err) => logger.error({err}, 'x post ticket sweep failed'), 60_000).stop;
}
