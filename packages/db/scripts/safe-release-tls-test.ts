/** Positive operational approval/TLS path on a NEW synthetic PostgreSQL server only. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {openOperationClient} from '../src/operation-client.js';
import {validateTarget,verifyTarget,targetConfirmation,type OperationTarget} from '../src/operation-target.js';
import {runNewsTitleBackfill} from '../src/news-title-operation.js';
import {normalizeArabic} from '../src/normalize.js';
const fixture:OperationTarget={mode:'fixture',url:process.env.DATABASE_URL??'',database:process.env.MIP_TARGET_DATABASE??'',
 databaseOid:process.env.MIP_TARGET_DATABASE_OID??'',systemIdentifier:process.env.MIP_TARGET_SYSTEM_IDENTIFIER??'',marker:'synthetic-tls-release-marker'};
const url=validateTarget(fixture);
if(fixture.database!=='mip_cursor_tls_release_20261014_test'||url.port!=='5450'||!process.env.MIP_SYNTHETIC_APPROVAL_PATH||!process.env.NODE_EXTRA_CA_CERTS)
 throw new Error('Explicit isolated TLS fixture/certificate/temporary synthetic approval path required');
const target={...fixture,mode:'operational' as const,approvalFile:process.env.MIP_SYNTHETIC_APPROVAL_PATH};
const approve=async(operation:string)=>writeFile(target.approvalFile,JSON.stringify({version:1,operation,approvedBy:'SYNTHETIC TEST ONLY',
 confirmation:targetConfirmation(target,operation),expiresAt:new Date(Date.now()+600000).toISOString()}));
await approve('synthetic-tls-fixture-init');const sql=openOperationClient(target,2);
try{
 await verifyTarget(sql,target,'synthetic-tls-fixture-init',true,targetConfirmation(target,'synthetic-tls-fixture-init'));
 const [empty]=await sql`SELECT count(*)::integer AS count FROM pg_tables WHERE schemaname='public'`;
 if(empty.count!==0)throw new Error('TLS fixture initialization refuses any existing schema');
 const roles=await sql`SELECT oid,rolname,rolsuper,rolcanlogin FROM pg_roles ORDER BY oid`;
 await sql`CREATE TABLE public.news_articles(id uuid PRIMARY KEY,title text NOT NULL,title_normalized text COLLATE "C")`;
 for(const title of ['أخبار آمنة','تهيئة اصطناعية','دقة المِؤشر'])await sql`INSERT INTO news_articles(id,title) VALUES(${randomUUID()},${title})`;
 await approve('news-title-backfill');
 const options={apply:false,confirmation:targetConfirmation(target,'news-title-backfill'),batchSize:2,statementMs:5000,lockMs:100,
  pauseMs:0,maxDurationMs:30000,maxWalBytes:16777216,maxDatabaseBytes:1073741824,maxWaitingLocks:0,maxRssBytes:536870912,maxReplicaLagBytes:16777216};
 assert.equal((await runNewsTitleBackfill(sql,target,options)).remaining,3);
 const result=await runNewsTitleBackfill(sql,target,{...options,apply:true});assert.equal(result.completed,3);assert.equal(result.remaining,0);
 const rows=await sql`SELECT title,title_normalized FROM news_articles`;assert.ok(rows.every(r=>r.title_normalized===normalizeArabic(r.title)));
 assert.deepEqual(await sql`SELECT oid,rolname,rolsuper,rolcanlogin FROM pg_roles ORDER BY oid`,roles);
 const [tls]=await sql`SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()`;assert.equal(tls.ssl,true);
 console.log(JSON.stringify({passed:true,tls:tls.version,syntheticApproval:true,...result,databaseRolesUnchanged:true}));
}finally{await sql.end({timeout:5});}
