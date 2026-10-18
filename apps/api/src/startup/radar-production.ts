/** Explicit profile for the user-approved restored local dataset. */
export function assertRadarProduction(env:NodeJS.ProcessEnv,flags:Record<string,unknown>){
 const url=new URL(String(flags.DATABASE_URL));
 if(env.NODE_ENV!=='production'||env.MIP_APPROVED_RELEASE!=='radar360-v1-20261018'||
  !['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='postgres'||url.port!=='5432'||
  url.pathname!=='/radar360_v1_20261018'||url.search||url.hash||flags.API_PORT!==3001||
  flags.APP_URL!=='https://monitoring.interactivedashboardpages.com'||env.MIP_NEWS_READER!=='legacy')
  throw Error('RADAR_PRODUCTION_PROFILE_DENIED');
 if(env.RUN_DB_MIGRATIONS_ON_START==='true')throw Error('Startup migrations forbidden');
 for(const key of ['LIVE_X_API','X_STREAM_ENABLED','AUTO_COLLECTION_ENABLED','AUTO_CLASSIFICATION_ENABLED',
  'NEWS_FETCH_ENABLED','ALERTS_ENABLED','ALLOW_INTERNAL_DATA_TO_EXTERNAL_AI','NEWS_SCRAPLING_ENABLED','NEWS_SCRAPLING_DYNAMIC_ENABLED'])
  if(flags[key]!==false)throw Error('Radar restored profile requires disabled gate: '+key);
}
