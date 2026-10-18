/** Local-only approval. Deliberately separate from fixture and operational guards. No dotenv/config. */
import postgres from 'postgres';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
export const LOCAL_IDENTITY={database:'mip',databaseOid:'16384',systemIdentifier:'7678829486367178790',
  container:'mip-postgres',containerId:'c9a80726e2825bd5e26b8e28e2e6bb7bbc5e6f70984106888225c35cca97c9af',host:'127.0.0.1',port:5433,volume:'mip_mip-pgdata'} as const;
export interface LocalTarget {mode:'local';url:string;database:string;databaseOid:string;systemIdentifier:string;containerId:string;approvalFile?:string}
export function validateLocalTarget(target:LocalTarget) {
  if(process.env.NODE_ENV==='test'||process.env.NODE_ENV==='production'||Object.keys(process.env).some(k=>k.startsWith('COOLIFY_')&&process.env[k]))throw new Error('Local mode unavailable in test/production/Coolify environment');
  let url:URL;try{url=new URL(target.url);}catch{throw new Error('Explicit local DATABASE_URL required');}
  if(target.mode!=='local'||target.database!==LOCAL_IDENTITY.database||target.databaseOid!==LOCAL_IDENTITY.databaseOid||
    target.systemIdentifier!==LOCAL_IDENTITY.systemIdentifier||target.containerId!==LOCAL_IDENTITY.containerId||
    !['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==LOCAL_IDENTITY.host||url.port!==String(LOCAL_IDENTITY.port)||
    url.pathname!=='/mip'||!url.username||!url.password||url.search||url.hash)throw new Error('Unapproved local target');
  return url;
}
export async function verifyLocalContainer() {
  const {stdout}=await promisify(execFile)('docker',['inspect',LOCAL_IDENTITY.container]);const [container]=JSON.parse(stdout);
  if(container.Id!==LOCAL_IDENTITY.containerId||container.Name!=='/'+LOCAL_IDENTITY.container||!container.State.Running||
    !container.HostConfig.PortBindings?.['5432/tcp']?.some((p:{HostPort:string})=>p.HostPort===String(LOCAL_IDENTITY.port))||
    !container.Mounts.some((m:{Name:string;Destination:string})=>m.Name===LOCAL_IDENTITY.volume&&m.Destination==='/var/lib/postgresql/data'))throw new Error('Local container identity mismatch');
  return Object.values(container.NetworkSettings.Networks).map((v:any)=>v.IPAddress);
}
export function openLocalClient(target:LocalTarget) {
  const url=validateLocalTarget(target);
  return postgres(target.url,{max:1,host:LOCAL_IDENTITY.host,port:LOCAL_IDENTITY.port,database:'mip',
    user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),ssl:false,connect_timeout:5,onnotice:()=>{},
    connection:{application_name:'mip-approved-local-0043',statement_timeout:30000,lock_timeout:3000,timezone:'UTC'}});
}
export function localConfirmation(target:LocalTarget,migrationSha256:string) {
  validateLocalTarget(target);return createHash('sha256').update(JSON.stringify({operation:'local-migration-0043',...LOCAL_IDENTITY,migrationSha256})).digest('hex');
}
export async function verifyLocalIdentity(sql:postgres.Sql|postgres.TransactionSql,target:LocalTarget) {
  validateLocalTarget(target);const addresses=await verifyLocalContainer();
  const [actual]=await sql`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,pg_is_in_recovery() AS recovery,
    host(inet_server_addr()) AS address,inet_server_port() AS port`;
  if(actual.database!==target.database||actual.oid!==target.databaseOid||actual.system_identifier!==target.systemIdentifier||
    actual.recovery||actual.port!==5432||!addresses.includes(actual.address))throw new Error('Local PostgreSQL identity mismatch');
}
export async function verifyLocalApproval(target:LocalTarget,sha256:string,confirmation?:string) {
  if(!target.approvalFile||confirmation!==localConfirmation(target,sha256))throw new Error('Explicit local operation/target confirmation required');
  const approval=JSON.parse(await readFile(target.approvalFile,'utf8'));
  if(approval.version!==1||approval.scope!=='local-only'||approval.operation!=='local-migration-0043'||approval.confirmation!==confirmation||
    approval.migrationSha256!==sha256||!approval.approvedBy||!Number.isFinite(Date.parse(approval.expiresAt))||Date.parse(approval.expiresAt)<=Date.now())throw new Error('Local approval invalid or expired');
  return approval;
}
export function localTargetFromEnv():LocalTarget {
  if(process.env.MIP_OPERATION_MODE!=='local')throw new Error('Explicit local mode required');
  return {mode:'local',url:process.env.DATABASE_URL??'',database:process.env.MIP_TARGET_DATABASE??'',databaseOid:process.env.MIP_TARGET_DATABASE_OID??'',
    systemIdentifier:process.env.MIP_TARGET_SYSTEM_IDENTIFIER??'',containerId:process.env.MIP_TARGET_CONTAINER_ID??'',approvalFile:process.env.MIP_LOCAL_APPROVAL_FILE};
}
