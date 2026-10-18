// Manual command only. No @mip/config, dotenv, startup hook, seed or fallback URL.
import {openOperationClient} from '../src/operation-client.js';
import {operationTargetFromEnv,validateTarget,targetConfirmation} from '../src/operation-target.js';
import {runNewsTitleBackfill} from '../src/news-title-operation.js';
const target=operationTargetFromEnv();validateTarget(target);
const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(x=>x!=='--apply'&&x!=='--dry-run'))throw new Error('Unknown option');
if(apply&&process.argv.includes('--dry-run'))throw new Error('Choose one mode');
const controller=new AbortController();
for(const event of ['SIGINT','SIGTERM'] as const)process.once(event,()=>controller.abort());
const number=(key:string,fallback:number)=>Number(process.env[key]??fallback);
const sql=openOperationClient(target,2);
try {
  const result=await runNewsTitleBackfill(sql,target,{apply,confirmation:process.env.MIP_CONFIRM_TARGET,
    batchSize:number('MIP_BACKFILL_BATCH_SIZE',100),statementMs:number('MIP_BACKFILL_STATEMENT_MS',10000),lockMs:number('MIP_BACKFILL_LOCK_MS',1000),
    pauseMs:number('MIP_BACKFILL_PAUSE_MS',100),maxDurationMs:number('MIP_BACKFILL_MAX_DURATION_MS',600000),
    maxWalBytes:number('MIP_BACKFILL_MAX_WAL_BYTES',268435456),maxDatabaseBytes:number('MIP_BACKFILL_MAX_DATABASE_BYTES',10737418240),
    maxWaitingLocks:number('MIP_BACKFILL_MAX_WAITING_LOCKS',0),maxRssBytes:number('MIP_BACKFILL_MAX_RSS_BYTES',536870912),
    maxReplicaLagBytes:number('MIP_BACKFILL_MAX_REPLICA_LAG_BYTES',16777216),signal:controller.signal,
    progress:counts=>console.log(JSON.stringify(counts))});
  console.log(JSON.stringify({...result,targetConfirmation:targetConfirmation(target,'news-title-backfill')}));if(result.status==='stopped')process.exitCode=2;
}catch {console.error('Backfill stopped safely; inspect private diagnostic context, verify target and resume remaining NULL rows.');process.exitCode=1;}
finally{await sql.end({timeout:5});}
