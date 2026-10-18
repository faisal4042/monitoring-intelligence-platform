/** Initializes only the empty ledger of a NEW schema-restored synthetic fixture, never repairs an existing ledger. */
import {openOperationClient} from '../src/operation-client.js';
import {operationTargetFromEnv,verifyTarget} from '../src/operation-target.js';
import {loadCursorRelease} from '../src/cursor-release.js';
const target=operationTargetFromEnv();
if(target.mode!=='fixture'||target.database!=='mip_cursor_release_clean_20261014_test')throw new Error('Dedicated new fixture only');
const sql=openOperationClient(target,1);
try{
 await verifyTarget(sql,target,'fixture-ledger-initialization',false);
 const [exists]=await sql`SELECT to_regclass('public._migrations') AS ledger`;
 if(exists.ledger)throw new Error('Never overwrite or repair existing ledger');
 const {manifest}=await loadCursorRelease();
 // The fixture schema was restored from the approved synthetic lab. No historical SQL or RBAC migrations are replayed.
 await sql.begin(async tx=>{
  await tx`CREATE TABLE public._migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
  for(const name of Object.keys({...manifest.prerequisites,...manifest.migrations}))await tx`INSERT INTO public._migrations(name) VALUES(${name})`;
 });
 console.log('Initialized synthetic schema fixture ledger; no historical SQL or seed executed');
}finally{await sql.end();}
