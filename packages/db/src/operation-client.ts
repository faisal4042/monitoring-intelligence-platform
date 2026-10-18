import postgres from 'postgres';
import {validateTarget,type OperationTarget} from './operation-target.js';
export type OperationSql=postgres.Sql;
export function openOperationClient(target:OperationTarget,max=2) {
  const url=validateTarget(target);
  return postgres(target.url,{max,onnotice:()=>{},ssl:target.mode==='operational'?'verify-full':false,
    host:url.hostname,port:Number(url.port||5432),database:target.database,
    user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),connect_timeout:5,target_session_attrs:'read-write',
    connection:{application_name:'mip-explicit-manual-cursor-operation',statement_timeout:10000,lock_timeout:1000}});
}
