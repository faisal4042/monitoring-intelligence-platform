/** Restores a verified private local backup to the NEW network-isolated verifier only. No application starts. */
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {LOCAL_IDENTITY,verifyLocalContainer} from '../src/local-operation-target.js';
const directory=process.env.MIP_LOCAL_BACKUP_DIRECTORY??'',container='mip-local-0043-restore-20261015',database='mip_local_0043_restore_20261015';
const id='8c56df05f6f8e6fdcf45f10334c3c90ea54268b10d580485ac2ff50039635649';
const run=promisify(execFile);
const query=async(target:string,db:string,text:string)=>{
 const {stdout}=await run('docker',['exec',target,'psql','-U','mip','-d',db,'-X','-v','ON_ERROR_STOP=1','-At','-c',text],{maxBuffer:10485760});return stdout.trim();
};
const catalogSQL=`BEGIN READ ONLY; SET LOCAL TIME ZONE 'UTC'; SELECT jsonb_build_object(
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',k.conname,'type',k.contype,'definition',pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname)
 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',i.relname,'definition',pg_get_indexdef(i.oid)) ORDER BY c.relname,i.relname)
 FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'))::text; COMMIT;`;
try{
 await verifyLocalContainer();
 const snapshot=JSON.parse(await readFile(join(directory,'backup-snapshot.json'),'utf8'));
 if(snapshot.source.systemIdentifier!==LOCAL_IDENTITY.systemIdentifier||snapshot.source.databaseOid!==LOCAL_IDENTITY.databaseOid||snapshot.source.containerId!==LOCAL_IDENTITY.containerId)throw new Error('Backup source mismatch');
 const hash=createHash('sha256');for await(const chunk of createReadStream(snapshot.archive))hash.update(chunk);if(hash.digest('hex')!==snapshot.sha256)throw new Error('Archive checksum mismatch');
 const {stdout}=await run('docker',['inspect',container]);const [actual]=JSON.parse(stdout);
 if(actual.Id!==id||!actual.State.Running||actual.HostConfig.NetworkMode!=='none'||Object.keys(actual.HostConfig.PortBindings??{}).length)throw new Error('Restore container isolation mismatch');
 const identity=(await query(container,database,"SELECT current_database(),(SELECT oid FROM pg_database WHERE datname=current_database()),(SELECT system_identifier FROM pg_control_system()),(SELECT count(*) FROM pg_tables WHERE schemaname='public')")).split('|');
 if(identity[0]!==database||identity[3]!=='0'||identity[2]===LOCAL_IDENTITY.systemIdentifier)throw new Error('Restore target not fresh/independent');
 const streamArchive=async(args:string[],collect:boolean)=>{
  const child=spawn('docker',['exec','-i',container,'pg_restore',...args],{stdio:['pipe','pipe','pipe']});let out='',error='';
  child.stdout.on('data',chunk=>{if(collect)out+=chunk;});child.stderr.on('data',chunk=>error+=chunk);
  const done=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('Archive inspection/restore failed')));});
  const transfer=pipeline(createReadStream(snapshot.archive),child.stdin).catch((error:{code?:string})=>{
    // --list legitimately closes stdin after its TOC. Accept transport EOF ONLY for read-only listing;
    // `done` must still prove exit 0. Never swallow a restore error or premature restore input closure.
    if(!collect||!['EOF','EPIPE','ERR_STREAM_PREMATURE_CLOSE'].includes(error.code??''))throw error;
  });
  await Promise.all([transfer,done]);
  if(error.trim())throw new Error('Restore diagnostics require review');return out;
 };
 await writeFile(join(directory,'archive-list.txt'),await streamArchive(['--list'],true));
 await streamArchive(['-U','mip','-d',database,'--exit-on-error'],false);
 const hashes:Record<string,{count:number;sha256:string}>={};
 for(const name of Object.keys(snapshot.tables)){
  const quoted='"'+name.replaceAll('"','""')+'"';
  const row=await query(container,database,`BEGIN READ ONLY; SET LOCAL TIME ZONE 'UTC'; SET LOCAL statement_timeout='30s';
   SELECT count(*)::text,encode(digest(COALESCE(string_agg(row,E'\\n' ORDER BY row),''),'sha256'),'hex') FROM (SELECT row_to_json(t)::text AS row FROM public.${quoted} t) rows; COMMIT;`);
  const parts=row.split('\n').find(line=>/^\d+\|[a-f0-9]{64}$/.test(line))!.split('|');hashes[name]={count:Number(parts[0]),sha256:parts[1]};
 }
 if(JSON.stringify(hashes)!==JSON.stringify(snapshot.tables))throw new Error('Restored table count/data fingerprint mismatch');
 const parseCatalog=(value:string)=>JSON.parse(value.split('\n').find(x=>x.startsWith('{'))!);
 const original=parseCatalog(await query(LOCAL_IDENTITY.container,'mip',catalogSQL)),restored=parseCatalog(await query(container,database,catalogSQL));
 if(JSON.stringify(original)!==JSON.stringify(restored))throw new Error('Restored constraints/indexes mismatch');
 const evidence={version:1,status:'restore-verified',verifiedAt:new Date().toISOString(),source:LOCAL_IDENTITY,archive:snapshot.archive,
  sha256:snapshot.sha256,restore:{container,id,database,databaseOid:identity[1],systemIdentifier:identity[2],network:'none'},
  tableCount:Object.keys(hashes).length,constraintCount:restored.constraints.length,indexCount:restored.indexes.length,tables:hashes};
 await writeFile(join(directory,'restore-evidence.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({status:evidence.status,tables:evidence.tableCount,constraints:evidence.constraintCount,indexes:evidence.indexCount,allFingerprintsEqual:true}));
}catch{console.error('Backup/restore verification FAILED; stop immediately. No original migration authorized.');process.exitCode=1;}
