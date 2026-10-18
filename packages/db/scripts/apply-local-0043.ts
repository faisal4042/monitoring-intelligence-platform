/** Manual local 0043 only. Default dry run. Never accepts fixture/operational mode or imports dotenv. */
import {localTargetFromEnv,openLocalClient} from '../src/local-operation-target.js';
import {runLocal0043} from '../src/local-0043-release.js';
const target=localTargetFromEnv();const apply=process.argv.includes('--apply');
if(process.argv.slice(2).some(x=>!['--apply','--dry-run'].includes(x))||apply&&process.argv.includes('--dry-run'))throw new Error('Invalid command options');
const sql=openLocalClient(target);
try{console.log(JSON.stringify(await runLocal0043(sql,target,{apply,confirmation:process.env.MIP_CONFIRM_TARGET,receipt:process.env.MIP_LOCAL_RECEIPT_PATH})));}
catch{console.error('Local 0043 preflight/apply failed. Stop; never repair/replay another migration automatically.');process.exitCode=1;}
finally{await sql.end({timeout:5});}
