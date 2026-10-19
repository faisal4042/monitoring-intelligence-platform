import {WorkerOwnership,bindWorkerOwnership} from './startup/worker-ownership.js';
import {installParentControl} from './startup/parent-control.js';
import {startPartitionCoverageObserver} from './workers/partition-coverage.worker.js';
import {drainTrackedTasks} from './workers/tracked-task.js';
import {config,collectionMode} from '@mip/config';
import {logger} from '@mip/logger';
import {sql,analyticsSql,processWorkerOwnerId} from '@mip/db';
import {buildApp} from './app.js';
import {ensureAutomaticQueries,startCollectionWorker} from './workers/collection.worker.js';
import {startClassificationWorker} from './workers/classification.worker.js';
import {startPartitionMaintenanceWorker} from './workers/partition-maintenance.worker.js';
import {startQueueIntakeWorker} from './workers/queue-intake.worker.js';
import {startWorkforceWorker} from './workers/workforce.worker.js';
import {startNewsFetchWorker} from './workers/news-fetch.worker.js';
import {startAlertsWorker} from './workers/alerts.worker.js';
import {startWhatsAppWorker} from './workers/whatsapp.worker.js';
import {startXStreamWorker} from './workers/x-stream.worker.js';
import {startReportExportWorker,startReportScheduleWorker} from './workers/reports.worker.js';
import {startXPostTicketWorker} from './workers/x-post-tickets.worker.js';
import {partitionCoverage} from './lib/partitions.js';
import {createRuntime,startupPlan} from './startup/runtime.js';
import {verifyLocalStartup,acquireWorkerLease} from './startup/local-preflight.js';
import {newsReaderMode} from './modules/news/reader-mode.js';
import {assertReleaseEnvironment} from './startup/release-protection.js';
if(config.NODE_ENV==='production'){
  if(process.env.MIP_STARTUP_PROFILE!=='release-preserve-data')throw new Error('Production requires approved preserve-data entrypoint');
  assertReleaseEnvironment(process.env,config);
  if(newsReaderMode!=='legacy')throw new Error('Production release excludes news migration 0045');
}
const plan=startupPlan(process.env.MIP_STARTUP_PROFILE);
const gate=plan.transitional?new WorkerOwnership():undefined;
if(gate)bindWorkerOwnership(gate);
const app=await buildApp({loggerInstance:logger});
const runtime=createRuntime(plan,{
  preflight:async()=>{
    if(!plan.transitional){
      if(process.env.MIP_STARTUP_PROFILE==='release-preserve-data'){
        const [excluded]=await sql`SELECT EXISTS(SELECT 1 FROM public._migrations WHERE name ~ '^004[567]_') AS installed`;
        if(excluded.installed)throw new Error('EXCLUDED_MIGRATION_PRESENT: release requires reviewed baseline without 0045/0046/0047');
      }
      const [f]=await sql`SELECT to_regclass('mip_fencing.lease') IS NOT NULL AS installed`;
      if(f.installed)throw new Error('FENCE_REQUIRES_TRANSITION_PROFILE');
      return;
    }
    if(newsReaderMode!=='legacy')throw new Error('Local transition requires legacy reader');
    await verifyLocalStartup(sql,config.DATABASE_URL,process.env);
    // Observe existing partition coverage; provisioning remains an independent operator action.
    const coverage=await partitionCoverage();
    if(coverage.status!=='ok')throw new Error('Existing partition coverage is insufficient; no automatic DDL in local transition');
    if(config.AUTO_COLLECTION_ENABLED){
      const [ready]=await sql`SELECT count(*)::int AS n FROM queries q JOIN query_versions v ON v.id=q.current_version_id AND v.query_id=q.id WHERE q.status='active' AND q.deleted_at IS NULL AND NOT q.is_paused AND v.compiled_length>0`;
      if(!ready.n)throw new Error('Automatic queries require explicit initialization before transition');
      if(collectionMode==='live'){
        const [watermarks]=await sql`SELECT count(*)::int AS n FROM queries q WHERE q.status='active' AND q.deleted_at IS NULL AND q.since_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM api_usage u WHERE u.query_id=q.id AND u.mode='demo')
          AND NOT EXISTS(SELECT 1 FROM api_usage u WHERE u.query_id=q.id AND u.mode='live' AND u.http_status BETWEEN 200 AND 299)`;
        if(watermarks.n)throw new Error('Demo watermarks need independently reviewed initialization; transition will not reset them');
      }
    }
    logger.info({reader:newsReaderMode,profile:'local-transition',collection:config.AUTO_COLLECTION_ENABLED,
      classification:config.AUTO_CLASSIFICATION_ENABLED,news:config.NEWS_FETCH_ENABLED},'local transition preflight; workers retain explicit gates; bootstrap writes skipped');
  },
  lease:()=>acquireWorkerLease(sql,{gate,ownerId:processWorkerOwnerId,onLost:reason=>{
    logger.error({err:reason},'worker ownership lost; admission closed; draining');
    if(process.connected)process.send?.({type:'mip:lease-lost'});
    void runtime.close().then(()=>process.exit(1),error=>{
      logger.error({err:error},'lease-loss drain failed; ownership remains invalid');
      if(process.connected)process.send?.({type:'mip:shutdown-failed',message:String(error)});
      process.exitCode=1;
    });
  }}),
  listen:()=>app.listen({port:config.API_PORT,host:process.env.NODE_ENV==='test'?'127.0.0.1':'0.0.0.0'}).then(()=>{}),
  maintenance:()=>startPartitionMaintenanceWorker(),
  initializeQueries:async()=>{const automaticQueries=await ensureAutomaticQueries();logger.info({automaticQueries},'automatic dictionary queries ready');},
  workerFactories:p=>[
    ()=>p.transitional ? startPartitionCoverageObserver() : async()=>{},
    ()=>config.QUEUE_WORKER_ENABLED ? startQueueIntakeWorker() : async()=>{},
    ()=>config.WORKFORCE_WORKER_ENABLED ? startWorkforceWorker() : async()=>{},
    ()=>startCollectionWorker({transitional:p.transitional}),
    ()=>startXStreamWorker({transitional:p.transitional}),
    ()=>startClassificationWorker({transitional:p.transitional}),
    ()=>startNewsFetchWorker({transitional:p.transitional}),
    ()=>startAlertsWorker({transitional:p.transitional}),
    // Off by default (WHATSAPP_ENABLED=false); separate from the alerts worker so a WhatsApp fault never affects Telegram/email.
    ()=>startWhatsAppWorker({transitional:p.transitional}),
    // Off by default; idle while migration 0047 is absent.
    ()=>config.REPORT_EXPORTS_ENABLED ? startReportExportWorker() : async()=>{},
    ()=>config.REPORT_SCHEDULES_ENABLED ? startReportScheduleWorker() : async()=>{},
    // Off by default: heals X post → ticket links (collection links inline; this retries gaps in the window).
    ()=>config.X_POST_TICKETS_ENABLED ? startXPostTicketWorker() : async()=>{},
  ],
  closeHttp:()=>app.close(),
  drainTasks:drainTrackedTasks,
  closePools:async()=>{await Promise.all([sql.end(),analyticsSql.end()]);},
});
function closeRuntime(){gate?.close();return runtime.close();}
if(gate)app.addHook('onRequest',async()=>{if(gate.state!=='active')throw Object.assign(new Error('Worker ownership unavailable'),{statusCode:503,code:'WORKER_OWNERSHIP_LOST'});});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{
  void closeRuntime().then(()=>process.exit(0),error=>{
    // Do not force termination of accepted writes or pretend shutdown completed.
    logger.error({err:error},'shutdown failed; operator intervention required');process.exitCode=1;
  });
});
installParentControl(closeRuntime);
await runtime.start().then(()=>{
 process.send?.({type:'mip:ready'});
 logger.info({port:config.API_PORT,reader:newsReaderMode,profile:plan.transitional?'local-transition':'normal',mode:collectionMode},'API ready');
 logger.info(collectionMode==='demo'?'DEMO MODE: no connection to the X API is possible (LIVE_X_API=false)':collectionMode==='dry_run'?'DRY RUN: queries are compiled and budgeted but never sent':'LIVE: real X API calls will be made and real quota consumed');
});
