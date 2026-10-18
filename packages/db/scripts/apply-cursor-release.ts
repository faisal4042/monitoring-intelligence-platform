// Dedicated manual release, never imported by application startup. No dotenv/config/seed.
import {openOperationClient} from '../src/operation-client.js';
import {operationTargetFromEnv,validateTarget,targetConfirmation} from '../src/operation-target.js';
import {runCursorRelease} from '../src/cursor-release.js';
const target=operationTargetFromEnv();validateTarget(target);
if(process.argv.slice(2).some(x=>x!=='--apply'&&x!=='--dry-run'))throw new Error('Unknown option');
const apply=process.argv.includes('--apply');if(apply&&process.argv.includes('--dry-run'))throw new Error('Choose one mode');
const sql=openOperationClient(target,1);
try{console.log(JSON.stringify({...await runCursorRelease(sql,target,{apply,confirmation:process.env.MIP_CONFIRM_TARGET}),targetConfirmation:targetConfirmation(target,'cursor-migration-0045')}));}
catch{console.error('Cursor release preflight/apply failed; no seed or unrelated migration executed. Stop for target/schema review.');process.exitCode=1;}
finally{await sql.end({timeout:5});}
