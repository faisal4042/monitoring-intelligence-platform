import {useEffect} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {AGENT_STATUS_LABELS,PERMISSIONS as P,type AgentStatus} from '@mip/shared';
import {api} from './api';
import {useAuth} from './auth';

export type StatusTimes = Record<AgentStatus|'logged'|'operational',number>;
export interface Performance {
  completedCycles:number;completedItems:number;avgAssignmentToCloseMin:number|null;reopened:number;escalated:number;
  firstAssignedItems:number;avgQueueWaitMin:number|null;open:number;escalatedOpen:number;oldestOpenMin:number|null;avgOpenAgeMin:number|null;
}
export interface MyWorkforce {
  status:{status:AgentStatus;started_at:string;source:string};team:{team_id:string;team_name:string}|null;
  maxOpen:number;autoAssign:boolean;autoAssignEnabled:boolean;open:number;escalatedOpen:number;completedToday:number;
  performance:Performance;time:StatusTimes;operationalStatuses:AgentStatus[];serverNow:string;range:{from:string;to:string};
  days:Array<{day:string;status:AgentStatus;seconds:number}>;
}
export interface BoardAgent {
  id:string;full_name:string;team_id:string;team_name:string;status:AgentStatus;status_since:string|null;status_source:string|null;
  last_heartbeat_at:string|null;maxOpen:number;autoAssign:boolean;open:number;escalatedOpen:number;closedToday:number;oldestOpenMin:number|null;
  performance:Performance;time:StatusTimes;
}
export interface Board {
  autoAssignEnabled:boolean;warnMinutes:number;starvationMinutes:number;serverNow:string;range:{from:string;to:string};
  agents:BoardAgent[];
  backlog:{waiting:number;starving:number;oldest_waiting_min:number|null;overdue:number;in_boxes:number;escalated:number;waiting_high:number;closedToday:number};
  bySection:Array<{section:string;waiting:number;in_boxes:number;escalated:number}>;
  byProgram:Array<{program_id:string;name:string;color:string|null;waiting:number;in_boxes:number;escalated:number}>;
  timeTotals:StatusTimes;operationalStatuses:AgentStatus[];
}
type Source='agent'|'team'|'system';
export interface Effective {
  programIds:{value:string[]|null;from:Source};intents:{value:string[]|null;from:Source};sections:{value:string[]|null;from:Source};
  maxOpen:{value:number;from:Source};autoAssign:{value:boolean;from:Source};acceptsHighPriority:{value:boolean;from:Source};
}
export interface SettingsOverview {
  autoAssignEnabled:boolean;systemMaxOpen:number;
  teams:Array<{id:string;name:string;team_program_ids:string[];program_ids:string[]|null;intents:string[]|null;sections:string[]|null;
    max_open:number|null;auto_assign:boolean|null;accepts_high_priority:boolean|null;effective:Effective}>;
  agents:Array<{id:string;full_name:string;email:string;team_id:string;status:AgentStatus;status_since:string|null;open:number;
    program_ids:string[]|null;intents:string[]|null;sections:string[]|null;max_open:number|null;auto_assign:boolean|null;
    accepts_high_priority:boolean|null;effective:Effective}>;
}
export interface SystemSettings {
  autoAssignEnabled:boolean;laneOrder:string[];starvationMinutes:number;defaultMaxOpen:number;
  heartbeatTimeoutMinutes:number;maxStatusHours:number;operationalStatuses:AgentStatus[];
}

export const STATUS_ORDER:AgentStatus[]=['available','break','meeting','training','away','offline'];
export const statusLabel=(s:string)=>AGENT_STATUS_LABELS[s as AgentStatus]?.ar??s;
export const SOURCE_LABELS:Record<Source,string>={agent:'مخصص للموظف',team:'موروث من الفريق',system:'افتراضي النظام'};

/** "3 س 12 د" from seconds. */
export function hours(seconds:number|null|undefined) {
  if(seconds==null)return '—';
  const m=Math.round(seconds/60);if(m<60)return `${m} د`;
  return `${Math.floor(m/60)} س ${m%60} د`;
}
export const minutesText=(m:number|null|undefined)=>m==null?'—':m<60?`${Math.round(m)} د`:`${Math.floor(m/60)} س ${Math.round(m%60)} د`;

/** The signed-in agent's status, figures and a status setter. */
export function useMyWorkforce(range='today') {
  const {can}=useAuth();const qc=useQueryClient();
  const enabled=can(P.QUEUE_WORK);
  const query=useQuery({queryKey:['workforce','me',range],queryFn:()=>api.get<MyWorkforce>(`/workforce/me?range=${range}`),
    enabled,refetchInterval:30000,refetchIntervalInBackground:false});
  const set=useMutation({mutationFn:(status:AgentStatus)=>api.post('/workforce/status',{status}),
    onSettled:()=>{qc.invalidateQueries({queryKey:['workforce']});qc.invalidateQueries({queryKey:['queue']});}});
  return {...query,enabled,setStatus:set};
}

/**
 * Keeps a chosen status alive while a page is open (every 60 s). It never
 * starts one: the server only extends a status the agent picked.
 */
export function useHeartbeat(active:boolean) {
  useEffect(()=>{
    if(!active)return;
    // Also from a background tab: agents switch tabs while still at work.
    const beat=()=>{api.post('/workforce/heartbeat').catch(()=>{});};
    beat();const timer=setInterval(beat,60000);
    return()=>clearInterval(timer);
  },[active]);
}
