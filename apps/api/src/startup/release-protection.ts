export const RELEASE_DISABLED_GATES=['LIVE_X_API','X_STREAM_ENABLED','AUTO_COLLECTION_ENABLED','AUTO_CLASSIFICATION_ENABLED','NEWS_FETCH_ENABLED',
  'ALERTS_ENABLED','QUEUE_WORKER_ENABLED','WORKFORCE_WORKER_ENABLED','REPORT_EXPORTS_ENABLED','REPORT_SCHEDULES_ENABLED',
  'X_POST_TICKETS_ENABLED','NEWS_SCRAPLING_ENABLED','NEWS_SCRAPLING_DYNAMIC_ENABLED','ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI'] as const;
export function assertReleaseEnvironment(env:NodeJS.ProcessEnv,flags:Record<string,unknown>){
  if(env.NODE_ENV!=='production'||env.MIP_APPROVED_RELEASE!=='mip-preserve-data-v1')throw new Error('Explicit approved production release profile required');
  if(env.RUN_DB_MIGRATIONS_ON_START==='true')throw new Error('Startup migrations forbidden');
  if(env.MIP_STARTUP_PROFILE&&env.MIP_STARTUP_PROFILE!=='release-preserve-data')throw new Error('Release startup profile mismatch');
  for(const key of RELEASE_DISABLED_GATES)if(flags[key]!==false)throw new Error('Release requires disabled gate: '+key);
}
