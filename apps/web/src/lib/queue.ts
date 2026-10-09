import {useEffect,useState} from 'react';
import type {QueueSection,QueueStatus,QueueReviewOutcome} from '@mip/shared';
export interface QueueReviewInput {
  outcome:QueueReviewOutcome;programId?:string|null;intent?:string|null;sentiment?:string|null;
  topicId?:string|null;subtopicId?:string|null;relevant?:boolean;linksConfirmed?:boolean;reason?:string;
}
export interface ReviewCatalog {
  programs:Array<{id:string;name_ar:string}>;
  topics:Array<{id:string;program_id:string;parent_id:string|null;level:number;name_ar:string}>;
  selfClaim:boolean;waitWarningMinutes:number;
}
export interface QueueReview {
  id:string;cycle:number;outcome:QueueReviewOutcome;reviewer_name:string;reviewed_at:string;reason:string|null;
  program_id:string|null;intent:string|null;sentiment:string|null;topic_id:string|null;subtopic_id:string|null;
  relevant:boolean;links_confirmed:boolean|null;corrected_fields:string[];ai:Record<string,unknown>;
}
export interface QueueItem {
  id:string;interaction_type:'post'|'story';section:QueueSection;section_hold:QueueSection|null;priority?:'normal'|'high';
  post_id:string|null;post_posted_at:string|null;program_id:string;team_id:string;status:QueueStatus;version:number;
  program_snapshot:{id:string;key:string;name:string;color:string};
  text:string|null;x_author_id:string|null;url:string|null;username:string|null;display_name:string|null;
  profile_image_url?:string|null;followers_count?:number|null;is_reply?:boolean|null;is_quote?:boolean|null;
  intent:string|null;relevance:string|null;sentiment:string|null;topic_id?:string|null;topic_name?:string|null;reason_ar?:string|null;
  ai_program_id?:string|null;ai_topic_id?:string|null;ai_subtopic_id?:string|null;ai_model?:string|null;
  intent_confidence?:number|null;relevance_confidence?:number|null;sentiment_confidence?:number|null;reviews?:QueueReview[];
  assignee_id:string|null;assignee_name:string|null;team_name:string;
  entered_at:string;first_assigned_at:string|null;assigned_at:string|null;first_started_at:string|null;started_at?:string|null;
  reopen_count?:number;last_reopened_at?:string|null;
  completed_at:string|null;completed_by:string|null;last_escalated_at:string|null;resolution:string|null;
  reassignment_count:number;escalation_count:number;
  // Story units and posts inside a story.
  story_id?:string|null;story_item_id?:string|null;merged_into_id?:string|null;
  story_title?:string|null;story_summary?:string|null;story_post_count?:number|null;story_first_seen_at?:string|null;
  story_last_seen_at?:string|null;story_state?:string|null;story_influencer_count?:number|null;story_score?:number|null;
  story_active_items?:number;parent_story_title?:string|null;
  // Held move: the team that owns this post's story.
  hold_team_id?:string|null;
  media?:Array<{url:string|null;type:string;previewImageUrl:string|null}>;
  notes?:Array<{id:string;body:string;author_name:string;created_at:string}>;
  events?:Array<{id:string;event_type:string;actor_name:string|null;from_status:QueueStatus|null;to_status:QueueStatus;
    reason:string|null;resolution:string|null;created_at:string;from_assignee:string|null;to_assignee:string|null;
    metadata?:{outcome?:QueueReviewOutcome;from?:string;to?:string;hold?:QueueSection|null;intoItem?:string;fromTeamName?:string|null;toTeamName?:string;
      auto?:boolean;trigger?:string;override?:string[];redistribution?:boolean}}>;
  members?:Array<{post_id:string;text:string|null;url:string|null;posted_at:string;username:string|null;display_name:string|null;
    profile_image_url:string|null;source_role:string;sentiment:string|null;item_id:string|null;item_status:QueueStatus|null;item_assignee_name:string|null}>;
  merged?:Array<{id:string;title:string|null;status:QueueStatus}>;
}
export interface QueueOptions {
  teams:Array<{id:string;name:string}>;
  programs:Array<{id:string;name_ar:string;team_id:string}>;
  members:Array<{id:string;full_name:string;team_id:string;kind?:string;status?:string;open?:number}>;
}
export interface QueueSummary {
  counts:Record<QueueStatus,number>;
  sections:Record<QueueSection,Record<QueueStatus,number>>;
  workload:Array<{id:string;full_name:string;team_id:string;team_name:string;open:number;escalated:number;agent_status:string;completed_today:number}>;
  held:number;updatedAt:string;
  views:Record<QueueSection,{mine:number;unassigned:number;closed:number}>;serverNow:string;
}
export interface QueueAlert {
  id:string;kind:'influencer'|'story'|'assigned'|'reopened';section:'influencer'|'story';created_at:string;read_at:string|null;
  item_id:string;program_name:string|null;title:string|null;author_name:string|null;
}
export interface AlertUnread {unread:number;unreadBySection:{influencer:number;story:number}}
export interface AlertPrefs {soundEnabled:boolean;toastsEnabled:boolean;volume:number}

export const INTENT_LABELS:Record<string,string>={
  complaint:'شكوى',inquiry:'استفسار',suggestion:'اقتراح',praise:'إشادة',news:'خبر',experience:'تجربة',
  warning:'تحذير',issue:'مشكلة',request:'طلب',other:'أخرى',
};
export const SENTIMENT_LABELS:Record<string,{text:string;cls:string}>={
  very_positive:{text:'إيجابي جداً',cls:'text-emerald-600'},positive:{text:'إيجابي',cls:'text-emerald-600'},
  neutral:{text:'محايد',cls:'muted'},negative:{text:'سلبي',cls:'text-red-600'},very_negative:{text:'سلبي جداً',cls:'text-red-600'},
};
export const STORY_STATE_LABELS:Record<string,string>={new:'جديدة',rising:'متصاعدة',steady:'مستقرة',fading:'تخفت',candidate:'أولية'};
export const SOURCE_LABELS={original:'تغريدة أصلية',reply:'رد',quote:'اقتباس'} as const;
export const sourceOf=(i:Pick<QueueItem,'is_reply'|'is_quote'>)=>i.is_reply?'reply':i.is_quote?'quote':'original';
export const ALERT_KIND_LABELS:Record<QueueAlert['kind'],string>={influencer:'مؤثر',story:'قصة',assigned:'أُسند إليك',reopened:'أُعيد فتحه لك'};

export function duration(from:string|null,to:string|null=new Date().toISOString()) {
  if(!from||!to)return '—';
  const min=Math.max(0,Math.floor((Date.parse(to)-Date.parse(from))/60000));
  return min<60?`${min} د`:`${Math.floor(min/60)} س ${min%60} د`;
}

/** The server's clock, advanced locally between refreshes, so timers never trust the browser's clock. */
export function useServerClock(serverNow:string|undefined,tickMs=1000) {
  const [elapsed,setElapsed]=useState(0);
  useEffect(()=>{setElapsed(0);const started=Date.now();const timer=setInterval(()=>setElapsed(Date.now()-started),tickMs);return()=>clearInterval(timer);},[serverNow,tickMs]);
  return serverNow?new Date(Date.parse(serverNow)+elapsed).toISOString():undefined;
}

/**
 * The live timer a card shows for open work: waiting for assignment, or time
 * in the assignee's box since the server-recorded assignment (there is no
 * "start" step; legacy in_progress items count the same way). Box time turns
 * amber past the configured minutes — a visual cue, not an SLA.
 */
export function workTimer(item:Pick<QueueItem,'status'|'entered_at'|'assigned_at'|'started_at'|'last_reopened_at'>,now:string|undefined,warnMinutes:number) {
  const since=item.status==='new'?item.last_reopened_at??item.entered_at:['assigned','in_progress'].includes(item.status)?item.assigned_at:null;
  if(!since||!now)return null;
  const label=item.status==='new'?'بانتظار الإسناد':'في الصندوق منذ';
  const warn=item.status!=='new'&&Date.parse(now)-Date.parse(since)>=warnMinutes*60000;
  return {label,text:duration(since,now),warn};
}
