/** Explicit transitional artifact entrypoint: old news reader + normalized writer. No DDL/backfill. */
if(process.env.MIP_NEWS_READER&&process.env.MIP_NEWS_READER!=='legacy')throw new Error('Transitional entrypoint requires legacy news reader');
process.env.MIP_NEWS_READER='legacy';
await import('./server.js');
export {};
