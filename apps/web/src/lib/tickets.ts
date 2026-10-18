/** Ticket engine client types and labels (API: /api/v1/tickets; answers 503 TICKETS_NOT_ACTIVATED until migration 0047). */
export type TicketStatus = 'open' | 'assigned' | 'in_progress' | 'pending' | 'escalated' | 'resolved' | 'closed';
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'مفتوحة غير مسندة', assigned: 'مسندة', in_progress: 'قيد المعالجة', pending: 'معلقة بانتظار العميل',
  escalated: 'مصعّدة', resolved: 'محلولة', closed: 'مغلقة',
};
export const TICKET_STATUS_TONE: Record<TicketStatus, string> = {
  open: 'warn', assigned: 'info', in_progress: 'info', pending: 'muted', escalated: 'bad', resolved: 'ok', closed: 'muted',
};
export const CHANNEL_LABELS: Record<string, string> = {
  x_mention: 'منشور X عام', x_reply: 'رد على X', x_dm: 'رسائل X الخاصة', facebook_comment: 'تعليق فيسبوك', facebook_inbox: 'رسائل فيسبوك',
  telegram: 'تيليجرام', youtube_comment: 'تعليق يوتيوب', youtube_video: 'فيديو يوتيوب', news_article: 'خبر', x_story: 'قصة متداولة على X',
  email: 'البريد', other: 'أخرى',
};
/** Source groups for the tickets page filter (each is a list of channels). */
export const SOURCE_FILTERS: Array<{key: string; ar: string; channels: string[] | null}> = [
  {key: 'all', ar: 'كل المصادر', channels: null}, {key: 'x', ar: 'X', channels: ['x_mention', 'x_reply', 'x_dm']},
  {key: 'news', ar: 'الأخبار', channels: ['news_article']}, {key: 'youtube', ar: 'YouTube', channels: ['youtube_video', 'youtube_comment']},
  {key: 'story', ar: 'القصص', channels: ['x_story']},
];
export const ACTION_LABELS: Record<string, string> = {
  claim: 'استلام', assign: 'إسناد', reassign: 'إعادة إسناد', unassign: 'إلغاء الإسناد', start: 'بدء المعالجة', reply: 'تسجيل رد',
  hold: 'تعليق', resume: 'استئناف', escalate: 'تصعيد', deescalate: 'إلغاء التصعيد', resolve: 'حل', close: 'إغلاق',
  set_priority: 'تغيير الأولوية', clear_review: 'إنهاء المراجعة', admin_correction: 'تصحيح إداري للإغلاق',
};
/** Inputs each action needs (mirrors the server state machine; the server re-validates). */
export const ACTION_NEEDS: Record<string, {reason?: 'required' | 'optional'; assignee?: boolean; body?: boolean; priority?: boolean}> = {
  assign: {assignee: true}, reassign: {assignee: true}, hold: {reason: 'required'}, escalate: {reason: 'required'},
  close: {reason: 'optional'}, reply: {body: true}, set_priority: {priority: true}, clear_review: {reason: 'required'},
  admin_correction: {reason: 'required', assignee: true},
};
export const EVENT_LABELS: Record<string, string> = {
  created: 'إنشاء التذكرة', message_attached: 'رسالة جديدة من العميل', late_message: 'رسالة متأخرة بعد الإغلاق (مراجعة)',
  assigned: 'إسناد', reassigned: 'إعادة إسناد', unassigned: 'إلغاء الإسناد', started: 'بدء المعالجة', replied: 'رد الموظف',
  on_hold: 'تعليق', resumed: 'استئناف', escalated: 'تصعيد', deescalated: 'إلغاء التصعيد', resolved: 'حل', closed: 'إغلاق',
  admin_correction: 'تصحيح إداري', priority_changed: 'تغيير الأولوية', review_flagged: 'تحتاج مراجعة', review_cleared: 'انتهت المراجعة',
  reopened: 'إعادة فتح من الطابور',
};
export const REVIEW_REASON_LABELS: Record<string, string> = {
  late_message: 'رسالة وصلت بعد الإغلاق عن حدث قبله', fallback_identity: 'لا يوجد معرف محادثة موثوق من المزود',
  queue_reopen_conflict: 'أُعيد فتح بطاقتها والمحادثة لها تذكرة نشطة أخرى',
};
export interface TicketRow {
  id: string; ticket_number: string; status: TicketStatus; priority: 'normal' | 'high'; channel: string; opened_at: string; last_activity_at: string;
  closed_at: string | null; message_count: number; needs_review: boolean; review_reason: string | null; assignee_id: string | null;
  assignee_name: string | null; program_name: string | null; program_color: string | null; customer_handle: string | null; customer_name: string | null;
  first_response_at: string | null; version: number;
}
export interface TicketDetail {
  ticket: TicketRow & Record<string, any>;
  conversation: {id: string; channel: string; provider: string; managed_account: string | null; provider_thread_id: string | null; identity_confidence: string; ticket_count: number; created_at: string};
  customer: {id: string; provider: string; handle: string | null; display_name: string | null; first_seen_at: string; last_seen_at: string};
  assignee: {id: string; full_name: string} | null; program: {id: string; name_ar: string; color: string | null} | null;
  messages: Array<{id: string; provider: string; provider_message_id: string; direction: 'inbound' | 'outbound' | 'internal_note'; author_kind: string; event_at: string; received_at: string; disposition: string; text: string | null; agent_name: string | null; post_id?: string | null; post_x_id?: string | null; post_url?: string | null; post_status?: string | null; post_collected_at?: string | null}>;
  events: Array<{version: number; event_type: string; from_status: string | null; to_status: string; actor_kind: string; reason: string | null; occurred_at: string; actor_name: string | null; assignee_name: string | null}>;
  previousTickets: Array<{id: string; ticket_number: string; status: TicketStatus; opened_at: string; closed_at: string | null}>;
  queueItems: Array<{id: string; status: string; interaction_type?: string; assigned_at: string | null; completed_at: string | null; assignee_name?: string | null}>;
  /** True when the ticket is worked on a queue card: status and assignment change only from the queue. */
  queueManaged?: boolean;
  actions: string[];
}
