/** Explicit local transition only. Not a production/Coolify entrypoint. No schema or query initialization. */
if(!process.env.DATABASE_URL)throw new Error('Local transition requires explicit DATABASE_URL; no env-file target fallback');
if(process.env.MIP_NEWS_READER && process.env.MIP_NEWS_READER!=='legacy')throw new Error('Local transition requires legacy reader');
if(process.env.MIP_STARTUP_PROFILE && process.env.MIP_STARTUP_PROFILE!=='local-transition')throw new Error('Local startup profile mismatch');
process.env.MIP_NEWS_READER='legacy';process.env.MIP_STARTUP_PROFILE='local-transition';
await import('./server.js');export {};
