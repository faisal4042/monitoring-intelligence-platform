/**
 * One monitoring cycle: program sweeps → rotating dictionary queries → tracked channels → statistics → comments → retention.
 * Search units are the scarce resource (Google: 100/day), so each cycle spends only its fair share of what is left
 * until the PT reset; the cheap default bucket (videos/playlistItems/commentThreads, 10k/day) keeps data fresh.
 */
import type {YouTubeSql} from '@mip/db/src/youtube-test-client.js';
import type {YouTubeGateway} from './gateway.js';
import type {Mode, QuotaManager} from './quota.js';
import {runChannel,runComments,runDiscovery,runStats,type RunSummary} from './collector.js';
import {retentionFromEnv,runRetention} from './retention.js';
import {refreshRelevance} from './relevance.js';
import {nextQuotaReset} from './endpoints.js';
import {workerCheckpoint} from '../../startup/worker-ownership.js';

export interface PlannedQuery {id:string;program_key:string;name:string;last_attempt_at:string|Date|null;pending_page_token:string|null}
export const isSweep=(name:string)=>/-sweep:\d+$/.test(name);
const STATS_EVERY_MS=3*3_600_000, COMMENTS_EVERY_MS=12*3_600_000, MAX_CHANNELS=10, MAX_COMMENT_VIDEOS=5;

/** Fair share of the remaining search units for this cycle (at least one while any remain). */
export function searchAllowance(remaining:number,msUntilReset:number,intervalMinutes:number){
 if(remaining<=0)return 0;
 const cyclesLeft=Math.max(1,Math.ceil(msUntilReset/(intervalMinutes*60_000)));
 return Math.min(remaining,Math.max(1,Math.round(remaining/cyclesLeft)));
}

/** Unlimited app policy runs every planned query; provider exhaustion still stops search. */
export function cycleAllowance(search:{limit:number|null;used:number;reserved:number;exhausted?:boolean}|undefined,msUntilReset:number,intervalMinutes:number){
 if(!search||search.exhausted)return 0;
 if(search.limit===null)return Number.MAX_SAFE_INTEGER;
 return searchAllowance(Math.max(0,search.limit-search.used-search.reserved),msUntilReset,intervalMinutes);
}

/** Sweeps first (oldest attempt first), then unfinished pagination, then the least recently attempted query per program in turn. */
export function selectQueries(queries:PlannedQuery[],allowance:number){
 const at=(q:PlannedQuery)=>q.last_attempt_at?new Date(q.last_attempt_at).getTime():0;
 const byAge=(a:PlannedQuery,b:PlannedQuery)=>at(a)-at(b)||a.name.localeCompare(b.name);
 const sweeps=queries.filter(q=>isSweep(q.name)).sort(byAge);
 const rest=queries.filter(q=>!isSweep(q.name)).sort((a,b)=>Number(!!b.pending_page_token)-Number(!!a.pending_page_token)||byAge(a,b));
 const lanes=new Map<string,PlannedQuery[]>();
 for(const q of rest)lanes.set(q.program_key,[...(lanes.get(q.program_key)??[]),q]);
 const rotation:PlannedQuery[]=[];
 for(let i=0;rotation.length<rest.length;i++)for(const lane of lanes.values())if(lane[i])rotation.push(lane[i]);
 return [...sweeps,...rotation].slice(0,allowance);
}

export async function runCycle(sql:YouTubeSql,gateway:YouTubeGateway,quota:QuotaManager,mode:Mode,now=new Date()){
 const results:Array<RunSummary&{purged?:unknown}>=[];
 // Rules may have changed since a video was linked; comments are only fetched for videos that still qualify.
 await refreshRelevance(sql);
 const stillRunning=async()=>{await workerCheckpoint();return !(await gateway.controls()).paused;};
 const [control]=await sql`SELECT interval_minutes FROM youtube_collector_controls WHERE singleton`;
 const search=(await quota.status(mode)).buckets.find((b:{bucket:string})=>b.bucket==='search');
 const allowance=cycleAllowance(search,nextQuotaReset(now).getTime()-now.getTime(),control.interval_minutes);
 const queries=await sql<PlannedQuery[]>`SELECT q.id,q.program_key,q.name,q.last_attempt_at,q.pending_page_token FROM youtube_search_queries q
  JOIN programs p ON p.key=q.program_key WHERE q.is_active AND p.is_active AND p.deleted_at IS NULL`;
 for(const q of selectQueries(queries,allowance)){if(!await stillRunning())return results;results.push(await runDiscovery(sql,gateway,q.id,now));}
 // Channels: playlistItems is exhaustive for a known channel and costs one default unit.
 const channels=await sql`SELECT id FROM youtube_channels WHERE is_active AND status='active'
  AND (last_success_at IS NULL OR last_success_at<now()-${control.interval_minutes}*interval '1 minute') ORDER BY last_success_at NULLS FIRST LIMIT ${MAX_CHANNELS}`;
 for(const c of channels){if(!await stillRunning())return results;results.push(await runChannel(sql,gateway,c.id));}
 const [stats]=await sql`SELECT max(finished_at) AS at FROM youtube_collection_runs WHERE lane='stats' AND status='succeeded' AND mode=${mode}`;
 if((!stats.at||now.getTime()-new Date(stats.at).getTime()>=STATS_EVERY_MS)&&await stillRunning())results.push(await runStats(sql,gateway,500));
 // Comments for relevant videos whose public comment count is ahead of what is stored.
 const due=await sql`SELECT v.id FROM youtube_videos v
  JOIN LATERAL (SELECT comment_count FROM youtube_video_stats s WHERE s.video_id=v.id ORDER BY captured_at DESC LIMIT 1) s ON true
  WHERE v.status='active' AND v.comments_state<>'disabled' AND s.comment_count>0
   AND EXISTS(SELECT 1 FROM youtube_video_programs vp WHERE vp.video_id=v.id AND coalesce(vp.review_status,vp.suggested_status) IN ('matched','confirmed'))
   AND s.comment_count>(SELECT count(*) FROM youtube_comments c WHERE c.video_id=v.id AND c.status='active')
   AND NOT EXISTS(SELECT 1 FROM youtube_collection_runs r WHERE r.lane='comments' AND r.target=v.youtube_video_id AND r.started_at>${new Date(now.getTime()-COMMENTS_EVERY_MS).toISOString()}::timestamptz)
  ORDER BY s.comment_count DESC LIMIT ${MAX_COMMENT_VIDEOS}`;
 for(const v of due){if(!await stillRunning())return results;results.push(await runComments(sql,gateway,v.id));}
 const [maintenance]=await sql`SELECT 1 FROM youtube_collection_runs WHERE lane='retention' AND status='succeeded' AND finished_at>now()-interval '1 day' LIMIT 1`;
 if(!maintenance)results.push(await runRetention(sql,gateway,retentionFromEnv()));
 return results;
}
