import {assertWorkerAdmission,workerAbortSignal} from '../startup/worker-ownership.js';
const flights=new Map<string,Promise<void>>();
export function trackedTask(name:string,task:(signal?:AbortSignal)=>Promise<void>){
 try{assertWorkerAdmission();}catch(error){return Promise.reject(error);}
 const prior=flights.get(name);if(prior)return prior;
 const flight=Promise.resolve().then(()=>{assertWorkerAdmission();return task(workerAbortSignal());}).finally(()=>{flights.delete(name);});
 flights.set(name,flight);return flight;
}
export async function drainTrackedTasks(){while(flights.size)await Promise.all([...flights.values()]);}
