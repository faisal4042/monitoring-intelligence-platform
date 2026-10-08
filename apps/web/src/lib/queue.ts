import type {QueueStatus} from '@mip/shared';
export interface QueueItem {
  id:string;post_id:string;post_posted_at:string;program_id:string;team_id:string;status:QueueStatus;version:number;
  program_snapshot:{id:string;key:string;name:string;color:string};
  text:string|null;x_author_id:string|null;url:string|null;username:string|null;display_name:string|null;
  intent:string|null;relevance:string|null;sentiment:string|null;topic_id?:string|null;topic_name?:string|null;reason_ar?:string|null;
  assignee_id:string|null;assignee_name:string|null;team_name:string;
  entered_at:string;first_assigned_at:string|null;assigned_at:string|null;first_started_at:string|null;
  completed_at:string|null;completed_by:string|null;last_escalated_at:string|null;resolution:string|null;
  reassignment_count:number;escalation_count:number;
  media?:Array<{url:string|null;type:string;previewImageUrl:string|null}>;
  notes?:Array<{id:string;body:string;author_name:string;created_at:string}>;
  events?:Array<{id:string;event_type:string;actor_name:string|null;from_status:QueueStatus|null;to_status:QueueStatus;
    reason:string|null;resolution:string|null;created_at:string;from_assignee:string|null;to_assignee:string|null}>;
}
export interface QueueOptions {
  teams:Array<{id:string;name:string}>;
  programs:Array<{id:string;name_ar:string;team_id:string}>;
  members:Array<{id:string;full_name:string;team_id:string}>;
}
export interface QueueSummary {
  counts:Record<QueueStatus,number>;
  workload:Array<{id:string;full_name:string;team_id:string;team_name:string;open:number;completed_today:number}>;
}
export function duration(from:string|null,to:string|null=new Date().toISOString()) {
  if(!from||!to)return '—';
  const min=Math.max(0,Math.floor((Date.parse(to)-Date.parse(from))/60000));
  return min<60?`${min} د`:`${Math.floor(min/60)} س ${min%60} د`;
}
