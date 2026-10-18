import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {Sql} from 'postgres';
import {verifyTarget,type OperationTarget} from './operation-target.js';
export const CURSOR_MIGRATION='0045_news_title_normalized.sql';
const directory=fileURLToPath(new URL('../migrations/',import.meta.url));
export const cursorManifestPath=fileURLToPath(new URL('../cursor-release-migrations.json',import.meta.url));
export async function loadCursorRelease(path=cursorManifestPath) {
  const manifest=JSON.parse(await readFile(path,'utf8')) as {version:number;name:string;migrations:Record<string,string>;prerequisites:Record<string,string>};
  if(manifest.version!==1||manifest.name!=='cursor-v1-0045'||Object.keys(manifest.migrations).join()!==CURSOR_MIGRATION) throw new Error('Only migration 0045 is allowed');
  const all=(await readdir(directory)).filter(x=>x.endsWith('.sql')).sort();
  if(JSON.stringify(Object.keys(manifest.prerequisites).sort())!==JSON.stringify(all.filter(x=>x!==CURSOR_MIGRATION))) throw new Error('Historical manifest does not match packaged SQL files');
  for(const [name,hash] of Object.entries({...manifest.prerequisites,...manifest.migrations}))
    if(createHash('sha256').update(await readFile(directory+name)).digest('hex')!==hash)throw new Error('Migration checksum mismatch: '+name);
  return {manifest,sql:await readFile(directory+CURSOR_MIGRATION,'utf8')};
}
async function column(sql:Sql) {
  return sql`SELECT data_type,is_nullable,collation_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='news_articles' AND column_name='title_normalized'`;
}
async function preflight(sql:Sql,release:Awaited<ReturnType<typeof loadCursorRelease>>) {
  const names=(await sql`SELECT name FROM public._migrations`).map(x=>String(x.name));
  const prerequisites=Object.keys(release.manifest.prerequisites);
  if(prerequisites.some(x=>!names.includes(x)))throw new Error('Historical/permission migration missing; refuse replay');
  if(names.some(x=>!prerequisites.includes(x)&&x!==CURSOR_MIGRATION))throw new Error('Unknown migration ledger entry');
  const rows=await column(sql),applied=names.includes(CURSOR_MIGRATION);
  if(applied ? rows.length!==1||rows[0].data_type!=='text'||rows[0].is_nullable!=='YES'||rows[0].collation_name!=='C' : rows.length!==0)
    throw new Error('Cursor ledger/schema mismatch');
  const base=await sql`SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='news_articles'
    AND column_name IN ('id','title','source_id','published_at','discovered_at')`;
  const types:Record<string,string>={id:'uuid',title:'text',source_id:'uuid',published_at:'timestamp with time zone',discovered_at:'timestamp with time zone'};
  if(base.length!==5||base.some(x=>x.data_type!==types[String(x.column_name)] || (x.column_name!=='published_at'&&x.is_nullable!=='NO')))throw new Error('News prerequisite schema mismatch');
  const pk=await sql`SELECT array_agg(a.attname ORDER BY k.ord) AS columns FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(attnum,ord) ON true
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
    WHERE c.conrelid='public.news_articles'::regclass AND c.contype='p' GROUP BY c.oid`;
  if(pk.length!==1||JSON.stringify(pk[0].columns)!=='["id"]')throw new Error('News primary key mismatch');
  return applied;
}
export async function runCursorRelease(sql:Sql,target:OperationTarget,opts:{apply?:boolean;confirmation?:string;manifestPath?:string;lockMs?:number}) {
  const release=await loadCursorRelease(opts.manifestPath);
  await verifyTarget(sql,target,'cursor-migration-0045',!!opts.apply,opts.confirmation);
  const applied=await preflight(sql,release);
  if(!opts.apply)return {status:'dry-run',pending:applied?[]:[CURSOR_MIGRATION]};
  const lockMs=opts.lockMs??5000;if(!Number.isInteger(lockMs)||lockMs<1||lockMs>5000)throw new Error('Invalid migration lock timeout');
  return sql.begin(async tx=>{
    await tx`SELECT set_config('lock_timeout',${String(lockMs)},true)`;
    await tx`SET LOCAL statement_timeout='60s'`;
    // Shares the existing approved-release lock; no other migration is executed here.
    await tx`SELECT pg_advisory_xact_lock(hashtext('mip:approved-release-migrations'))`;
    await verifyTarget(tx as unknown as Sql,target,'cursor-migration-0045',true,opts.confirmation);
    const done=await preflight(tx as unknown as Sql,release);
    if(!done){await tx.unsafe(release.sql);await tx`INSERT INTO public._migrations(name) VALUES(${CURSOR_MIGRATION})`;}
    if(!(await preflight(tx as unknown as Sql,release)))throw new Error('Migration schema postcheck failed');
    return {status:done?'already-applied':'committed',pending:[]};
  });
}
