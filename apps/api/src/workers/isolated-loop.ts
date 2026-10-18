import {managedLoop} from './managed-loop.js';
let sequence=0;
export function isolatedLoop(work:()=>Promise<unknown>,onError:(error:unknown)=>void,milliseconds:number){
 return managedLoop('isolated-'+(++sequence),work,onError,milliseconds);
}
