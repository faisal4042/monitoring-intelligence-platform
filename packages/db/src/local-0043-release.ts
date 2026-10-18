import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type postgres from 'postgres';
import {verifyLocalIdentity,verifyLocalApproval,localConfirmation,type LocalTarget,LOCAL_IDENTITY} from './local-operation-target.js';
import {dataSnapshot} from './local-data-snapshot.js';
const manifestFile=fileURLToPath(new URL('../local-release-0043.json',import.meta.url));
export async function loadLocal0043() {
 const manifest=JSON.parse(await readFile(manifestFile,'utf8')) as {version:number;name:string;migration:string;sha256:string;prerequisites:string[]};
 if(manifest.version!==1||manifest.name!=='local-saved-searches-0043'||manifest.migration!=='0043_saved_searches.sql')throw new Error('Only local migration 0043 approved');
 const directory=fileURLToPath(new URL('../migrations/',import.meta.url));
 const files=(await readdir(directory)).filter(n=>n.endsWith('.sql')&&n!==manifest.migration&&n!=='0045_news_title_normalized.sql').sort();
 if(JSON.stringify(files)!==JSON.stringify([...manifest.prerequisites].sort()))throw new Error('Local manifest historical names mismatch');
 const bytes=await readFile(directory+manifest.migration),text=bytes.toString('utf8');
 if(createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('0043 SHA256 mismatch');
 const code=text.replace(/--[^\r\n]*/g,'');
 if(/\b(?:DELETE|DROP|TRUNCATE|UPDATE|INSERT|ALTER|GRANT|REVOKE)\b/i.test(code)||code.split(';').filter(x=>x.trim()).length!==3)throw new Error('0043 must contain only its approved additive DDL');
 return {manifest,text};
}
export async function checkSavedSearches(sql:postgres.Sql|postgres.TransactionSql) {
 const columns=await sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='saved_searches' ORDER BY ordinal_position`;
 const expected=[['id','uuid','NO'],['owner_id','uuid','NO'],['name','text','NO'],['query','text','NO'],['tab','text','NO'],['period','jsonb','NO'],['sort','text','YES'],
  ['visibility','text','NO'],['last_run_at','timestamp with time zone','YES'],['run_count','integer','NO'],['alert_enabled','boolean','NO'],['alert_watermark','timestamp with time zone','YES'],
  ['created_at','timestamp with time zone','NO'],['updated_at','timestamp with time zone','NO'],['deleted_at','timestamp with time zone','YES']];
 if(JSON.stringify(columns.map(c=>[c.column_name,c.data_type,c.is_nullable]))!==JSON.stringify(expected))throw new Error('0043 columns mismatch');
 const indexes=await sql`SELECT i.relname,pg_get_indexdef(i.oid) AS definition,x.indisvalid FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid='public.saved_searches'::regclass ORDER BY i.relname`;
 if(indexes.length!==3||indexes.some(i=>!i.indisvalid))throw new Error('0043 indexes mismatch');
 const owner=indexes.find(i=>i.relname==='idx_saved_searches_owner'),shared=indexes.find(i=>i.relname==='idx_saved_searches_shared');
 if(!owner?.definition.includes('(owner_id, updated_at DESC) WHERE (deleted_at IS NULL)')||
  !shared?.definition.includes('(updated_at DESC) WHERE ((deleted_at IS NULL) AND (visibility = \'shared\'::text))'))throw new Error('0043 partial index definitions mismatch');
 const constraints=await sql`SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.saved_searches'::regclass`;
 if(constraints.filter(c=>c.contype==='c').length!==4||!constraints.some(c=>c.contype==='p'&&c.definition==='PRIMARY KEY (id)')||
  !constraints.some(c=>c.contype==='f'&&c.definition==='FOREIGN KEY (owner_id) REFERENCES users(id)'))throw new Error('0043 constraints mismatch');
 return {columns:columns.length,indexes:indexes.map(i=>i.relname),constraints:constraints.length};
}
async function preflight(sql:postgres.Sql|postgres.TransactionSql,release:Awaited<ReturnType<typeof loadLocal0043>>) {
 const names=(await sql`SELECT name FROM public._migrations ORDER BY name`).map(r=>String(r.name));
 if(release.manifest.prerequisites.some(n=>!names.includes(n))||names.some(n=>!release.manifest.prerequisites.includes(n)&&n!==release.manifest.migration))throw new Error('Local ledger mismatch; no historical replay');
 const objects=await sql`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('saved_searches','saved_searches_pkey','idx_saved_searches_owner','idx_saved_searches_shared')`;
 const types=await sql`SELECT typname FROM pg_type WHERE typnamespace='public'::regnamespace AND typname='saved_searches'`;
 const applied=names.includes(release.manifest.migration);
 if(!applied&&(objects.length||types.length))throw new Error('Partial/conflicting saved_searches objects');
 if(applied)await checkSavedSearches(sql);
 const [health]=await sql`SELECT (SELECT count(*) FROM pg_locks WHERE NOT granted)::integer AS waiting,
  (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start<now()-interval '1 minute')::integer AS long_transactions`;
 if(health.waiting||health.long_transactions)throw new Error('Local locks/long transactions require review');
 return applied;
}
export async function runLocal0043(sql:postgres.Sql,target:LocalTarget,options:{apply?:boolean;confirmation?:string;receipt?:string}) {
 const release=await loadLocal0043();await verifyLocalIdentity(sql,target);
 const applied=await preflight(sql,release);
 if(!options.apply)return {status:'dry-run',pending:applied?[]:[release.manifest.migration],confirmation:localConfirmation(target,release.manifest.sha256)};
 const approval=await verifyLocalApproval(target,release.manifest.sha256,options.confirmation);
 const evidence=JSON.parse(await readFile(approval.restoreEvidencePath,'utf8'));
 if(evidence.status!=='restore-verified'||evidence.source.containerId!==LOCAL_IDENTITY.containerId||evidence.source.systemIdentifier!==LOCAL_IDENTITY.systemIdentifier||
  evidence.source.databaseOid!==LOCAL_IDENTITY.databaseOid||evidence.sha256!==approval.backupSha256)throw new Error('Verified backup/restore evidence required');
 const hash=createHash('sha256');for await(const chunk of createReadStream(evidence.archive))hash.update(chunk);
 if(hash.digest('hex')!==evidence.sha256)throw new Error('Verified backup archive changed');
 const receipt=await sql.begin('isolation level repeatable read',async tx=>{
  await tx`SET LOCAL lock_timeout='3s'`;await tx`SET LOCAL statement_timeout='30s'`;
  await tx`SELECT pg_advisory_xact_lock(hashtext('mip:approved-release-migrations'))`;
  await verifyLocalIdentity(tx,target);const done=await preflight(tx,release);
  const before=await dataSnapshot(tx);
  if(!done){await verifyLocalIdentity(tx,target);await tx.unsafe(release.text);await tx`INSERT INTO public._migrations(name) VALUES(${release.manifest.migration})`;}
  const schema=await checkSavedSearches(tx),after=await dataSnapshot(tx);
  for(const name of Object.keys(before))if(name!=='_migrations'&&JSON.stringify(before[name])!==JSON.stringify(after[name]))throw new Error('Existing table fingerprint changed; rollback');
  if(Object.keys(after).some(n=>!Object.hasOwn(before,n)&&n!=='saved_searches')||after.saved_searches.count!==0||
    after._migrations.count!==before._migrations.count+(done?0:1))throw new Error('Unexpected migration data/ledger changes; rollback');
  return {status:done?'already-applied':'committed',source:LOCAL_IDENTITY,migration:release.manifest.migration,migrationSha256:release.manifest.sha256,
   backupSha256:evidence.sha256,at:new Date().toISOString(),schema,before,after};
 });
 if(options.receipt)await writeFile(options.receipt,JSON.stringify(receipt,null,2));
 return {status:receipt.status,migration:receipt.migration,schema:receipt.schema,existingDataUnchanged:true};
}
