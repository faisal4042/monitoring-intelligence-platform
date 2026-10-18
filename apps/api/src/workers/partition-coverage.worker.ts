/** Local transition observes existing coverage; it never provisions schema. */
import {partitionCoverage} from '../lib/partitions.js';
import {logger} from '@mip/logger';
import {managedLoop} from './managed-loop.js';
export function startPartitionCoverageObserver(){
 return managedLoop('partition-coverage',async()=>{
   const coverage=await partitionCoverage();
   if(coverage.status!=='ok')logger.error({coverage},'Explicit partition maintenance approval needed; local transition never creates partitions');
 },err=>logger.error({err},'partition coverage observation failed'),86400000).stop;
}
