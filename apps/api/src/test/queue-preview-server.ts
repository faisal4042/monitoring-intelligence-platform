/** Local browser tests only: guarded *_test DB, HTTP app without workers. */
import {makeApp,sql} from './harness.js';

const app=await makeApp();
await app.listen({host:'127.0.0.1',port:3107});
console.log('Isolated queue preview API: http://127.0.0.1:3107 (no workers)');
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=>{
  await app.close();await sql.end();process.exit(0);
});
