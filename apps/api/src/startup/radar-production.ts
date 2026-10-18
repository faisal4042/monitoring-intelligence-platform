/** Explicit restored-data and live profiles; neither runs seed or migrations. */
export function assertRadarProduction(env:NodeJS.ProcessEnv,flags:Record<string,unknown>){
 const url=new URL(String(flags.DATABASE_URL));
 const live=env.MIP_APPROVED_RELEASE==='radar360-live-v1-20261018';
 if(env.NODE_ENV!=='production'||(!live&&env.MIP_APPROVED_RELEASE!=='radar360-v1-20261018')||
  !['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='postgres'||url.port!=='5432'||
  url.pathname!=='/radar360_v1_20261018'||url.search||url.hash||flags.API_PORT!==3001||
  flags.APP_URL!=='https://monitoring.interactivedashboardpages.com'||env.MIP_NEWS_READER!=='legacy')
  throw Error('RADAR_PRODUCTION_PROFILE_DENIED');
 if(env.RUN_DB_MIGRATIONS_ON_START==='true')throw Error('Startup migrations forbidden');
 if(live){
  // Live X uses only the filtered stream; periodic search polling stays off.
  if(flags.AUTO_COLLECTION_ENABLED!==false||flags.X_DRY_RUN!==false)throw Error('LIVE_PROFILE_REQUIRES_STREAM_ONLY');
  for(const key of ['LIVE_X_API','X_STREAM_ENABLED','AUTO_CLASSIFICATION_ENABLED','NEWS_FETCH_ENABLED','ALERTS_ENABLED',
   'ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI','NEWS_SCRAPLING_ENABLED','NEWS_SCRAPLING_DYNAMIC_ENABLED','X_POST_TICKETS_ENABLED'])
   if(flags[key]!==true)throw Error('Live profile requires enabled gate: '+key);
  if(!flags.X_POST_TICKETS_SINCE||Number.isNaN(Date.parse(String(flags.X_POST_TICKETS_SINCE))))throw Error('LIVE_TICKET_WINDOW_REQUIRED');
 }else{
  for(const key of ['LIVE_X_API','X_STREAM_ENABLED','AUTO_COLLECTION_ENABLED','AUTO_CLASSIFICATION_ENABLED',
   'NEWS_FETCH_ENABLED','ALERTS_ENABLED','ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI','NEWS_SCRAPLING_ENABLED','NEWS_SCRAPLING_DYNAMIC_ENABLED'])
   if(flags[key]!==false)throw Error('Radar restored profile requires disabled gate: '+key);
 }
}
