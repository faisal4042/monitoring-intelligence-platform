/** Real restored data, isolated database only. Never an operational entrypoint. */
import {config} from '@mip/config';
import {sql,analyticsSql,processWorkerOwnerId} from '@mip/db';
import {buildApp} from './app.js';
import {verifyIsolatedTarget} from './startup/isolated-target.js';
import {acquireWorkerLease} from './startup/local-preflight.js';
import {WorkerOwnership,bindWorkerOwnership} from './startup/worker-ownership.js';
import {drainTrackedTasks} from './workers/tracked-task.js';
import {startReportExportWorker,startReportScheduleWorker} from './workers/reports.worker.js';
import {startQueueIntakeWorker} from './workers/queue-intake.worker.js';
import {startWorkforceWorker} from './workers/workforce.worker.js';
import {existsSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
await verifyIsolatedTarget(sql,config.DATABASE_URL);
if(config.API_PORT!==3292||config.APP_URL!=='http://127.0.0.1:5292'||config.LIVE_X_API||config.X_STREAM_ENABLED||config.AUTO_COLLECTION_ENABLED||
 config.AUTO_CLASSIFICATION_ENABLED||config.NEWS_FETCH_ENABLED||config.ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI||config.ALERTS_ENABLED)
 throw Error('ISOLATED_RUNTIME_FLAGS_DENIED');
const gate=new WorkerOwnership();bindWorkerOwnership(gate);
let close:()=>Promise<void>=async()=>{};
const release=await acquireWorkerLease(sql,{gate,ownerId:processWorkerOwnerId,onLost:()=>{void close().finally(()=>{process.exitCode=1;});}});
const app=await buildApp({logger:false,trustProxy:false});
app.addHook('onRequest',async()=>{await gate.checkpoint();});
let stopReports:()=>void|Promise<void>=()=>{};
let closing:Promise<void>|undefined;
const stopFile=resolve(process.env.MIP_ISOLATED_RUNTIME!,'api-stop-request');
const stopTimer=setInterval(()=>{if(existsSync(stopFile)){unlinkSync(stopFile);void close();}},1000);
close=()=>closing??=(async()=>{clearInterval(stopTimer);await app.close();await stopReports();await drainTrackedTasks();await release();await Promise.all([sql.end(),analyticsSql.end()]);})();
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
process.on('message',m=>{if(m&&typeof m==='object'&&(m as {type?:string}).type==='mip:stop')void close();});
try{
 await app.listen({host:'127.0.0.1',port:3292});
 if(config.REPORT_EXPORTS_ENABLED)stopReports=startReportExportWorker();
 if(config.REPORT_SCHEDULES_ENABLED){const stopExports=stopReports;const stopSchedules=startReportScheduleWorker();stopReports=async()=>{await Promise.all([stopExports(),stopSchedules()]);};}
 if(config.QUEUE_WORKER_ENABLED||config.WORKFORCE_WORKER_ENABLED){const reportStops=stopReports;
  const localStops=[...(config.QUEUE_WORKER_ENABLED?[startQueueIntakeWorker()]:[]),...(config.WORKFORCE_WORKER_ENABLED?[startWorkforceWorker()]:[])];
  stopReports=async()=>{await Promise.all([reportStops(),...localStops.map(stop=>stop())]);};}
 process.send?.({type:'mip:ready'});console.log('ISOLATED_UNIFIED_API_READY http://127.0.0.1:3292');
}catch(error){await close();throw error;}
