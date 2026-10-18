/** Explicit local snapshot/online backup only; no migrations, seed, or application singleton. */
import {createWriteStream,createReadStream} from 'node:fs';
import {writeFile,mkdir} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isAbsolute,resolve,join} from 'node:path';
import {localTargetFromEnv,openLocalClient,verifyLocalIdentity,LOCAL_IDENTITY} from '../src/local-operation-target.js';
import {dataSnapshot} from '../src/local-data-snapshot.js';
const target=localTargetFromEnv(),directory=process.env.MIP_LOCAL_BACKUP_DIRECTORY??'';
if(!isAbsolute(directory)||!resolve(directory).startsWith(resolve(process.env.LOCALAPPDATA??'','MIPBackups')+'\\'))throw new Error('Private backup directory outside workspace required');
await mkdir(directory,{recursive:true});const sql=openLocalClient(target);
try{
 await verifyLocalIdentity(sql,target);
 await sql.begin('isolation level repeatable read read only',async tx=>{
  await verifyLocalIdentity(tx,target);
  const [snapshot]=await tx`SELECT pg_export_snapshot() AS id`;
  const tables=await dataSnapshot(tx);
  const archive=join(directory,'mip-before-0043.dump');
  const child=spawn('docker',['exec',LOCAL_IDENTITY.container,'pg_dump','-U','mip','-d','mip','-Fc','--snapshot='+snapshot.id],{stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',chunk=>error+=chunk);
  const completed=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error('pg_dump failed')));});
  await Promise.all([pipeline(child.stdout,createWriteStream(archive,{flags:'wx'})),completed]);
  if(error.trim())throw new Error('pg_dump emitted diagnostics; stop for private review');
  const hash=createHash('sha256');for await(const chunk of createReadStream(archive))hash.update(chunk);
  const sha256=hash.digest('hex');
  await writeFile(join(directory,'backup-snapshot.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),source:LOCAL_IDENTITY,
    archive,sha256,exportedSnapshot:snapshot.id,tables},null,2));
  console.log(JSON.stringify({status:'backup-complete',archive,sha256,tableCount:Object.keys(tables).length}));
 });
}catch{console.error('Local backup/snapshot failed; no migration authorized.');process.exitCode=1;}
finally{await sql.end({timeout:5});}
