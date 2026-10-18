import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import type {sql as databaseSql} from '@mip/db';
export interface IsolatedIdentity {container:string;containerId:string;volume:string;network:string;database:string;port:number;system:string;oid:string;marker:string}
export function assertIsolatedUrl(raw:string,p:IsolatedIdentity){
 const u=new URL(raw);
 if(process.env.NODE_ENV==='production'||Object.keys(process.env).some(k=>k.startsWith('COOLIFY_')&&process.env[k])||
   p.database!=='mip_unified_isolated_20261017'||p.port!==5467||p.container!=='mip-unified-isolated-20261017'||
   p.volume!=='mip-unified-isolated-20261017-pgdata'||p.network!=='mip-unified-isolated-20261017-net'||
   !['postgres:','postgresql:'].includes(u.protocol)||u.hostname!=='127.0.0.1'||u.port!=='5467'||u.pathname!=='/'+p.database||u.search||u.hash||!u.username||!u.password)
  throw Error('ISOLATED_TARGET_DENIED');
 return u;
}
export function isolatedIdentity():IsolatedIdentity{
 if(!process.env.MIP_ISOLATED_IDENTITY_FILE)throw Error('Explicit isolated identity required');
 return JSON.parse(readFileSync(process.env.MIP_ISOLATED_IDENTITY_FILE,'utf8'));
}
export async function verifyIsolatedTarget(sql:typeof databaseSql,raw:string,p=isolatedIdentity()){
 assertIsolatedUrl(raw,p);
 const [c]=JSON.parse(execFileSync('docker',['inspect',p.container],{encoding:'utf8',windowsHide:true}));
 const [net]=JSON.parse(execFileSync('docker',['network','inspect',p.network],{encoding:'utf8',windowsHide:true}));
 const networks=Object.keys(c.NetworkSettings.Networks);
 const bindings=c.NetworkSettings.Ports?.['5432/tcp'];
 if(c.Id!==p.containerId||!c.State.Running||c.Config.Labels?.['mip.scope']!=='isolated-review'||net.Internal!==true||
  networks.length!==2||!networks.includes(p.network)||!networks.includes(p.container+'-host-net')||
  !Array.isArray(bindings)||bindings.length!==1||bindings[0].HostIp!=='127.0.0.1'||bindings[0].HostPort!=='5467'||
  c.Mounts.length!==1||c.Mounts[0].Name!==p.volume||c.Mounts[0].Destination!=='/var/lib/postgresql/data')throw Error('ISOLATED_DOCKER_IDENTITY_DENIED');
 const [id]=await sql`SELECT current_database() AS database,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
  (SELECT system_identifier::text FROM pg_control_system()) AS system,pg_is_in_recovery() AS recovery`;
 if(id.database!==p.database||id.oid!==p.oid||id.system!==p.system||id.recovery)throw Error('ISOLATED_DATABASE_IDENTITY_DENIED');
 const rows=await sql`SELECT token FROM isolated_review.marker`;
 if(rows.length!==1||rows[0].token!==p.marker)throw Error('ISOLATED_MARKER_DENIED');
}
