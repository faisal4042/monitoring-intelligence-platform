export type Stop = () => void | Promise<void>;
export interface StartupPlan { maintenance:boolean; initializeQueries:boolean; transitional:boolean; }
export function startupPlan(profile:string|undefined):StartupPlan {
 if(profile==='release-preserve-data')return {maintenance:false,initializeQueries:false,transitional:false};
 if(profile===undefined||profile==='normal')return {maintenance:true,initializeQueries:true,transitional:false};
 if(profile==='local-transition')return {maintenance:false,initializeQueries:false,transitional:true};
 throw new Error('Unknown backend startup profile');
}
export interface RuntimeDependencies {
 preflight():Promise<void>; listen():Promise<void>; maintenance():Promise<Stop>;
 initializeQueries():Promise<unknown>; lease():Promise<Stop>;
 workerFactories(plan:StartupPlan):(()=>Stop)[]; closeHttp():Promise<void>;
 drainTasks():Promise<void>; closePools():Promise<void>;
}
export function createRuntime(plan:StartupPlan,deps:RuntimeDependencies){
 let startPromise:Promise<void>|undefined,closePromise:Promise<void>|undefined,cleanupPromise:Promise<void>|undefined;
 let stopping=false;const stops:Stop[]=[];let release:Stop|undefined;
 const checkpoint=()=>{if(stopping)throw new Error('Runtime closing');};
 const cleanup=()=>cleanupPromise??=(async()=>{
   stopping=true;
   const http=deps.closeHttp();
   const drains=stops.map(stop=>Promise.resolve().then(stop));
   const results=await Promise.allSettled([http,...drains]);
   const failure=results.find(r=>r.status==='rejected');
   if(failure?.status==='rejected')throw failure.reason;
   // Includes durable refresh tasks accepted by HTTP before close began.
   await deps.drainTasks();
   await release?.();await deps.closePools();
 })();
 const start=()=>startPromise??=(async()=>{
   checkpoint();await deps.preflight();checkpoint();
   if(plan.transitional){release=await deps.lease();checkpoint();}
   await deps.listen();checkpoint();
   if(plan.maintenance){stops.push(await deps.maintenance());checkpoint();}
   if(plan.initializeQueries){await deps.initializeQueries();checkpoint();}
   for(const factory of deps.workerFactories(plan)){checkpoint();stops.push(factory());}
 })().catch(async error=>{await cleanup();throw error;});
 const close=()=>closePromise??=(async()=>{stopping=true;await startPromise?.catch(()=>{});await cleanup();})();
 return {start,close};
}
