/** Restored Radar360 v1 production profile: fenced ownership, no seed or migrations. */
import {mkdir} from 'node:fs/promises';
import {setDefaultResultOrder} from 'node:dns';
import {setDefaultAutoSelectFamily} from 'node:net';
import {config} from '@mip/config';
import {sql,analyticsSql,processWorkerOwnerId} from '@mip/db';
import {buildApp} from './app.js';
import {acquireWorkerLease} from './startup/local-preflight.js';
import {WorkerOwnership,bindWorkerOwnership} from './startup/worker-ownership.js';
import {drainTrackedTasks} from './workers/tracked-task.js';
import {startReportExportWorker,startReportScheduleWorker} from './workers/reports.worker.js';
import {startQueueIntakeWorker} from './workers/queue-intake.worker.js';
import {startWorkforceWorker} from './workers/workforce.worker.js';
import {assertRadarProduction} from './startup/radar-production.js';
// Google restricts this key to the approved server IPv4 address.
setDefaultResultOrder('ipv4first');setDefaultAutoSelectFamily(false);
assertRadarProduction(process.env,config);
const [identity]=await sql`SELECT current_database() AS name,pg_is_in_recovery() AS recovery,
 EXISTS(SELECT 1 FROM public._migrations WHERE name='0052_unified_tickets_card_merge.sql') AS ready`;
if(identity.name!=='radar360_v1_20261018'||identity.recovery||!identity.ready)throw Error('RADAR_PRODUCTION_DATABASE_NOT_READY');
await mkdir(config.REPORT_EXPORT_DIR,{recursive:true});
const gate=new WorkerOwnership();bindWorkerOwnership(gate);
const stops:Array<()=>void|Promise<void>>=[];
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
let release:(()=>Promise<void>)|undefined;
let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{
 await app?.close();
 await Promise.all(stops.map(stop=>Promise.resolve().then(stop)));
 await drainTrackedTasks();
 await release?.();
 await Promise.all([sql.end(),analyticsSql.end()]);
})();
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
try{
 release=await acquireWorkerLease(sql,{gate,ownerId:processWorkerOwnerId,onLost:()=>{
  console.error('RADAR_PRODUCTION_OWNERSHIP_LOST');void close().finally(()=>{process.exitCode=1;});
 }});
 app=await buildApp({trustProxy:['loopback','uniquelocal']});
 app.addHook('onRequest',async()=>{await gate.checkpoint();});
 if(config.REPORT_EXPORTS_ENABLED)stops.push(startReportExportWorker());
 if(config.REPORT_SCHEDULES_ENABLED)stops.push(startReportScheduleWorker());
 if(config.QUEUE_WORKER_ENABLED)stops.push(startQueueIntakeWorker());
 if(config.WORKFORCE_WORKER_ENABLED)stops.push(startWorkforceWorker());
 await app.listen({host:'0.0.0.0',port:config.API_PORT});
 console.log('RADAR360_V1_PRODUCTION_READY');
}catch(error){await close();throw error;}
