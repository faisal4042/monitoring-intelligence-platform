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
export const QUEUE_ACTIONS = ['assign','unassign','start','escalate','complete','reopen','notes'] as const;
export type QueueAction = typeof QUEUE_ACTIONS[number];
export const QUEUE_STATUS_LABELS: Record<QueueStatus,string> = {
  new:'غير مسند', assigned:'مسند', in_progress:'قيد العمل', escalated:'مصعّد', completed:'مكتمل',
};
export const QUEUE_RESOLUTION_LABELS = {handled:'تمت المعالجة',no_action_needed:'لا يحتاج إجراء',not_actionable:'غير قابل للمعالجة'};
export const QUEUE_EVENT_LABELS: Record<string,string> = {
  created:'أُضيف للطابور',assigned:'أُسند',reassigned:'أُعيد إسناده',unassigned:'أُلغي الإسناد',
  started:'بدأ العمل',escalated:'صُعّد',deescalated:'أُعيد توجيهه',completed:'اكتمل',reopened:'أُعيد فتحه',note_added:'أُضيفت ملاحظة',
  section_changed:'نُقل بين الأقسام',transferred:'نُقل إلى فريق آخر',section_review:'نقل بانتظار مراجعة المشرف',story_merged:'دُمجت القصة',
};
