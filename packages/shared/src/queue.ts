export const QUEUE_STATUSES = ['new','assigned','in_progress','escalated','completed'] as const;
export type QueueStatus = typeof QUEUE_STATUSES[number];
/** One section per item, priority story > influencer > general (decided server-side). */
export const QUEUE_SECTIONS = ['general','influencer','story'] as const;
export type QueueSection = typeof QUEUE_SECTIONS[number];
export const QUEUE_SECTION_LABELS: Record<QueueSection,{ar:string;en:string}> = {
  general:{ar:'الرصد العام',en:'General Monitoring'},
  influencer:{ar:'رصد المؤثرين',en:'Influencer Monitoring'},
  story:{ar:'رصد القصص',en:'Story Monitoring'},
};
export const QUEUE_RESOLUTIONS = ['handled','no_action_needed','not_actionable'] as const;
/** 'start' is gone: work time starts at the server-recorded assignment. Old 'started' events stay in history. */
export const QUEUE_ACTIONS = ['assign','unassign','escalate','complete','reopen','notes'] as const;
export type QueueAction = typeof QUEUE_ACTIONS[number];
export const QUEUE_STATUS_LABELS: Record<QueueStatus,string> = {
  new:'غير مسند', assigned:'في الصندوق', in_progress:'في الصندوق', escalated:'مصعّد', completed:'مغلق',
};
/** Monitoring review outcomes (closing = review completed, not customer case resolved). */
export const QUEUE_REVIEW_OUTCOMES = ['confirmed','corrected','irrelevant','no_action'] as const;
export type QueueReviewOutcome = typeof QUEUE_REVIEW_OUTCOMES[number];
export const QUEUE_REVIEW_OUTCOME_LABELS: Record<QueueReviewOutcome,string> = {
  confirmed:'التصنيفات صحيحة', corrected:'تم تصحيح التصنيفات', irrelevant:'التفاعل غير ذي صلة', no_action:'التفاعل لا يتطلب إجراء',
};
export const QUEUE_RESOLUTION_LABELS = {handled:'تمت المعالجة',no_action_needed:'لا يحتاج إجراء',not_actionable:'غير قابل للمعالجة'};
export const QUEUE_EVENT_LABELS: Record<string,string> = {
  created:'أُضيف للطابور',assigned:'أُسند',reassigned:'أُعيد إسناده',unassigned:'أُلغي الإسناد',
  started:'بدأت المراجعة',escalated:'صُعّد',deescalated:'أُعيد توجيهه',completed:'أُغلق — اكتملت المراجعة',reopened:'أُعيد فتحه',note_added:'أُضيفت ملاحظة',
  section_changed:'نُقل بين الأقسام',priority_changed:'تغيّرت الأولوية',transferred:'نُقل إلى فريق آخر',section_review:'نقل بانتظار مراجعة المشرف',story_merged:'دُمجت القصة',
};

/** Agent availability. Only 'available' receives automatic assignments. */
export const AGENT_STATUSES = ['available','break','away','meeting','training','offline'] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];
export const AGENT_STATUS_LABELS: Record<AgentStatus,{ar:string;en:string}> = {
  available:{ar:'متاح',en:'Available'}, break:{ar:'استراحة',en:'Break'}, away:{ar:'خارج المكتب',en:'Away'},
  meeting:{ar:'اجتماع',en:'Meeting'}, training:{ar:'تدريب',en:'Training'}, offline:{ar:'غير متصل',en:'Offline'},
};
export const STATUS_SOURCE_LABELS = {agent:'الموظف',supervisor:'المشرف',system:'النظام'} as const;
export const QUEUE_PRIORITIES = ['normal','high'] as const;
export type QueuePriority = typeof QUEUE_PRIORITIES[number];
export const QUEUE_PRIORITY_LABELS: Record<QueuePriority,string> = {normal:'عادية',high:'عالية'};
/** Intents an agent may be limited to ('interaction type' in queue settings). Stories have no intent. */
export const QUEUE_INTENTS = ['complaint','inquiry','suggestion','praise','news','experience','warning','issue','request','other'] as const;
