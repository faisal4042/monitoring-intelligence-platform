import type {QueueSection,QueueStatus} from '@mip/shared';
export interface QueueItem {
  id:string;interaction_type:'post'|'story';section:QueueSection;section_hold:QueueSection|null;
  post_id:string|null;post_posted_at:string|null;program_id:string;team_id:string;status:QueueStatus;version:number;
  program_snapshot:{id:string;key:string;name:string;color:string};
  text:string|null;x_author_id:string|null;url:string|null;username:string|null;display_name:string|null;
  profile_image_url?:string|null;followers_count?:number|null;is_reply?:boolean|null;is_quote?:boolean|null;
  intent:string|null;relevance:string|null;sentiment:string|null;topic_id?:string|null;topic_name?:string|null;reason_ar?:string|null;
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
    metadata?:{from?:QueueSection;to?:QueueSection;hold?:QueueSection|null;intoItem?:string;fromTeamName?:string|null;toTeamName?:string}}>;
  members?:Array<{post_id:string;text:string|null;url:string|null;posted_at:string;username:string|null;display_name:string|null;
    profile_image_url:string|null;source_role:string;sentiment:string|null;item_id:string|null;item_status:QueueStatus|null;item_assignee_name:string|null}>;
  merged?:Array<{id:string;title:string|null;status:QueueStatus}>;
}
export interface QueueOptions {
  teams:Array<{id:string;name:string}>;
  programs:Array<{id:string;name_ar:string;team_id:string}>;
  members:Array<{id:string;full_name:string;team_id:string}>;
}
export interface QueueSummary {
  counts:Record<QueueStatus,number>;
  sections:Record<QueueSection,Record<QueueStatus,number>>;
  workload:Array<{id:string;full_name:string;team_id:string;team_name:string;open:number;in_progress:number;completed_today:number}>;
  held:number;updatedAt:string;
}
export interface QueueAlert {
  id:string;kind:'influencer'|'story'|'assigned';section:'influencer'|'story';created_at:string;read_at:string|null;
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
export const ALERT_KIND_LABELS:Record<QueueAlert['kind'],string>={influencer:'مؤثر',story:'قصة',assigned:'أُسند إليك'};

export function duration(from:string|null,to:string|null=new Date().toISOString()) {
  if(!from||!to)return '—';
  const min=Math.max(0,Math.floor((Date.parse(to)-Date.parse(from))/60000));
  return min<60?`${min} د`:`${Math.floor(min/60)} س ${min%60} د`;
}
