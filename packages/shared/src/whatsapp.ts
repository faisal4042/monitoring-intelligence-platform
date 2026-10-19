/**
 * WhatsApp notification channel (Meta WhatsApp Business Platform — Cloud API).
 * Shared by the API and the web app: permissions, the event catalogue, message
 * statuses, E.164 phone handling and template variables.
 */

/**
 * Proposed permissions (migration 0055 creates the rows, grants none).
 * Deliberately NOT part of PERMISSIONS / ALL_PERMISSIONS: admin is
 * ALL_PERMISSIONS and the seed rebuilds system roles from that list, so adding
 * them there would grant them to admin on the next seed. Granting is a separate,
 * approved RBAC change (docs/whatsapp/README.md).
 */
export const WHATSAPP_PERMISSIONS = {
  VIEW: 'whatsapp:view',
  CONFIGURE: 'whatsapp:configure',
  TOGGLE: 'whatsapp:toggle',
  RECIPIENTS: 'whatsapp:recipients',
  TEMPLATES: 'whatsapp:templates',
  LOG: 'whatsapp:log',
  TEST_SEND: 'whatsapp:test_send',
} as const;
export type WhatsAppPermission = (typeof WHATSAPP_PERMISSIONS)[keyof typeof WHATSAPP_PERMISSIONS];
export const ALL_WHATSAPP_PERMISSIONS = Object.values(WHATSAPP_PERMISSIONS) as WhatsAppPermission[];

export const WHATSAPP_PERMISSION_LABELS: Record<WhatsAppPermission, string> = {
  'whatsapp:view': 'عرض إعدادات واتساب وحالتها',
  'whatsapp:configure': 'تعديل إعدادات اتصال واتساب وأنواع التنبيهات',
  'whatsapp:toggle': 'تفعيل قناة واتساب وتعطيلها وإيقافها مؤقتًا',
  'whatsapp:recipients': 'إدارة مستلمي واتساب ومسارات التوجيه',
  'whatsapp:templates': 'إدارة قوالب رسائل واتساب',
  'whatsapp:log': 'عرض سجل رسائل واتساب',
  'whatsapp:test_send': 'إرسال رسالة واتساب تجريبية',
};

export type WhatsAppEventGroup = 'monitoring' | 'queue' | 'operations';
/**
 * available: wired to data the platform already stores.
 * partial:   wired, but narrower than the name suggests (see `note`).
 * unavailable: the platform does not record this event yet — listed so the gap is visible, never sent.
 */
export type WhatsAppEventAvailability = 'available' | 'partial' | 'unavailable';
/** Who receives an event by default when no explicit route exists. */
export type WhatsAppAudience = 'assignee' | 'supervisors' | 'role' | 'program_team' | 'recipient';

export interface WhatsAppEventDef {
  key: string;
  group: WhatsAppEventGroup;
  label: string;
  availability: WhatsAppEventAvailability;
  /** Where the event comes from, or why it cannot be sent yet. */
  note: string;
  /** Default audience when no route is configured for the event. */
  defaultAudience: WhatsAppAudience;
  /** Mandatory alerts cannot be switched off by the employee (operational duty); optional ones can. */
  optional: boolean;
}

export const WHATSAPP_EVENTS: readonly WhatsAppEventDef[] = [
  // ── Monitoring ──
  { key: 'issue_new', group: 'monitoring', label: 'اكتشاف قضية جديدة', availability: 'available', note: 'قصة إشارات تنتقل إلى حالة «جديد».', defaultAudience: 'program_team', optional: true },
  { key: 'crisis_potential', group: 'monitoring', label: 'اكتشاف أزمة محتملة', availability: 'unavailable', note: 'لا يسجّل النظام مفهوم «أزمة» حاليًا؛ يحتاج قاعدة تصنيف معتمدة.', defaultAudience: 'supervisors', optional: true },
  { key: 'volume_spike', group: 'monitoring', label: 'ارتفاع مفاجئ في حجم التفاعلات', availability: 'unavailable', note: 'مؤشرات الارتفاع تُحسب لحظيًا في لوحة التحكم ولا تُخزَّن كأحداث.', defaultAudience: 'supervisors', optional: true },
  { key: 'complaint_high_priority', group: 'monitoring', label: 'شكوى عالية الأولوية', availability: 'partial', note: 'تفاعل في الطابور رُفعت أولويته إلى «عالية» وتصنيف نوعه «شكوى».', defaultAudience: 'supervisors', optional: false },
  { key: 'negative_high_impact', group: 'monitoring', label: 'محتوى سلبي مرتفع التأثير', availability: 'partial', note: 'منشور ذو صلة بمشاعر سلبية من حساب يتجاوز حدّ المتابعين المحدد.', defaultAudience: 'supervisors', optional: true },
  { key: 'topic_rising', group: 'monitoring', label: 'موضوع متصاعد', availability: 'available', note: 'قصة إشارات تنتقل إلى حالة «يتصاعد».', defaultAudience: 'program_team', optional: true },
  { key: 'influencer_post', group: 'monitoring', label: 'منشور مهم من حساب مؤثر', availability: 'available', note: 'تنبيه «مؤثر» في الطابور لحساب مؤثر متابَع.', defaultAudience: 'program_team', optional: true },
  { key: 'news_breaking', group: 'monitoring', label: 'خبر عاجل مرتبط بالبرامج', availability: 'unavailable', note: 'الأخبار لا تُربط بالبرامج ولا تُصنَّف «عاجلة» عند التخزين.', defaultAudience: 'program_team', optional: true },
  // ── Queue and tickets ──
  { key: 'interaction_assigned', group: 'queue', label: 'إسناد تفاعل إلى موظف', availability: 'available', note: 'حدث «إسناد» في الطابور؛ يصل للموظف المُسند إليه.', defaultAudience: 'assignee', optional: true },
  { key: 'ticket_assigned', group: 'queue', label: 'إسناد تذكرة إلى موظف', availability: 'available', note: 'حدث «إسناد» على التذكرة؛ يصل للموظف المُسند إليه.', defaultAudience: 'assignee', optional: true },
  { key: 'ticket_urgent', group: 'queue', label: 'وصول تذكرة عاجلة', availability: 'available', note: 'رفع أولوية تذكرة أو تفاعل إلى «عالية».', defaultAudience: 'supervisors', optional: false },
  { key: 'sla_breached', group: 'queue', label: 'تجاوز مدة المعالجة المستهدفة', availability: 'available', note: 'تفاعل مفتوح تجاوز حدّ الانتظار المضبوط في إعدادات الطابور.', defaultAudience: 'supervisors', optional: false },
  { key: 'tickets_overdue', group: 'queue', label: 'وجود تذاكر متأخرة', availability: 'available', note: 'ملخص بعدد التفاعلات المتأخرة، مرة واحدة في كل فترة ملخص.', defaultAudience: 'supervisors', optional: true },
  { key: 'ticket_reassigned', group: 'queue', label: 'إعادة إسناد تذكرة', availability: 'available', note: 'إعادة إسناد أو نقل تفاعل أو تذكرة؛ يصل للمُسند إليه الجديد.', defaultAudience: 'assignee', optional: true },
  { key: 'ticket_escalated', group: 'queue', label: 'تصعيد تذكرة إلى المشرف', availability: 'available', note: 'حدث «تصعيد» في الطابور أو على التذكرة.', defaultAudience: 'supervisors', optional: false },
  { key: 'followup_action', group: 'queue', label: 'متابعة جديدة تستدعي إجراء', availability: 'partial', note: 'رسالة جديدة من العميل على تذكرة مُسندة.', defaultAudience: 'assignee', optional: true },
  // ── Operations ──
  { key: 'x_collection_stopped', group: 'operations', label: 'توقف جمع بيانات إكس', availability: 'available', note: 'تفعيل الإيقاف العام لجمع إكس.', defaultAudience: 'role', optional: false },
  { key: 'source_failed', group: 'operations', label: 'تعطل مصدر رصد', availability: 'available', note: 'مصدر أخبار انتقلت صحته إلى «متعطل».', defaultAudience: 'role', optional: true },
  { key: 'news_jobs_failed', group: 'operations', label: 'فشل مهام جمع الأخبار', availability: 'available', note: 'عدد مهام الجلب الفاشلة في الساعة بلغ الحد المحدد.', defaultAudience: 'role', optional: true },
  { key: 'x_quota_near_limit', group: 'operations', label: 'اقتراب استهلاك إكس من الحد', availability: 'partial', note: 'يعمل فقط عند وجود ميزانية بحد شهري؛ الاستهلاك الحالي بلا حد.', defaultAudience: 'role', optional: false },
  { key: 'processing_failures', group: 'operations', label: 'فشل متكرر في معالجة البيانات', availability: 'unavailable', note: 'لا يحتفظ النظام بعدّاد لإخفاقات المعالجة.', defaultAudience: 'role', optional: true },
  { key: 'platform_critical', group: 'operations', label: 'مشكلة تقنية حرجة في المنصة', availability: 'unavailable', note: 'لا يوجد سجل أعطال تقنية مخزَّن يمكن الاعتماد عليه.', defaultAudience: 'role', optional: false },
] as const;

export const WHATSAPP_EVENT_KEYS = WHATSAPP_EVENTS.map((e) => e.key);
export const WHATSAPP_TEST_EVENT = 'test_message';
export const whatsappEvent = (key: string) => WHATSAPP_EVENTS.find((e) => e.key === key);
export const WHATSAPP_GROUP_LABELS: Record<WhatsAppEventGroup, string> = {
  monitoring: 'تنبيهات الرصد', queue: 'تنبيهات الطابور والتذاكر', operations: 'تنبيهات التشغيل',
};

/**
 * Message lifecycle. `accepted` = Meta accepted the API request (it returned a
 * message id) — NOT proof of delivery. `sent`/`delivered`/`read`/`failed` come
 * only from Meta's status webhooks.
 */
export const WHATSAPP_STATUSES = ['queued', 'processing', 'accepted', 'sent', 'delivered', 'read', 'failed', 'cancelled'] as const;
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];
export const WHATSAPP_STATUS_LABELS: Record<WhatsAppStatus, string> = {
  queued: 'بانتظار الإرسال', processing: 'قيد المعالجة', accepted: 'تم قبول الطلب', sent: 'تم الإرسال',
  delivered: 'تم التسليم', read: 'تمت القراءة', failed: 'فشل الإرسال', cancelled: 'أُلغي',
};
/** Order of the forward path; a webhook can only move a message forward on it (failed is terminal). */
export const WHATSAPP_STATUS_RANK: Record<WhatsAppStatus, number> = {
  queued: 0, processing: 1, accepted: 2, sent: 3, delivered: 4, read: 5, failed: 6, cancelled: 6,
};

export type WhatsAppIntegrationState = 'not_configured' | 'ready' | 'disabled' | 'paused' | 'error';
export const WHATSAPP_INTEGRATION_LABELS: Record<WhatsAppIntegrationState, string> = {
  not_configured: 'غير مهيأ', ready: 'جاهز', disabled: 'معطل', paused: 'موقوف مؤقتًا', error: 'خطأ',
};

export const TEMPLATE_META_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'paused', 'disabled'] as const;
export type TemplateMetaStatus = (typeof TEMPLATE_META_STATUSES)[number];
export const TEMPLATE_STATUS_LABELS: Record<TemplateMetaStatus, string> = {
  draft: 'مسودة (لم يُرسل لـ Meta)', pending: 'بانتظار اعتماد Meta', approved: 'معتمد', rejected: 'مرفوض', paused: 'موقوف من Meta', disabled: 'معطل من Meta',
};

/**
 * Variables a template may reference, in the order the template declares them
 * ({{1}}, {{2}} …). Values are built from sanitized, non-personal fields only:
 * no customer handle, phone, email or message text ever reaches WhatsApp.
 */
export const WHATSAPP_TEMPLATE_VARIABLES = {
  program: 'اسم البرنامج',
  alert_type: 'نوع التنبيه',
  priority: 'الأولوية',
  detected_at: 'تاريخ الرصد',
  summary: 'ملخص مختصر (بلا بيانات شخصية)',
  ticket_number: 'رقم التذكرة',
  details_url: 'رابط التفاصيل الداخلي',
  count: 'عدد',
} as const;
export type WhatsAppTemplateVariable = keyof typeof WHATSAPP_TEMPLATE_VARIABLES;
export const WHATSAPP_TEMPLATE_VARIABLE_KEYS = Object.keys(WHATSAPP_TEMPLATE_VARIABLES) as WhatsAppTemplateVariable[];

/** E.164: '+', country code 1–9, then up to 14 more digits (15 digits max). */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalizes user input to E.164. Accepts spaces, dashes, brackets and a 00
 * prefix; rejects anything without an explicit country code (we never guess one).
 */
export function normalizeE164(input: string): string | null {
  const trimmed = input.trim().replace(/[\s\-().]/g, '').replace(/^00/, '+');
  // Arabic-Indic and Eastern Arabic-Indic digits → ASCII.
  const ascii = trimmed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return E164.test(ascii) ? ascii : null;
}

/** «+9665••••4567»: country code and last four only. */
export function maskPhone(e164: string | null | undefined, last4?: string | null): string {
  if (!e164 && last4) return `••••${last4}`;
  if (!e164) return '—';
  return `${e164.slice(0, Math.min(5, e164.length - 4))}${'•'.repeat(Math.max(0, e164.length - 9))}${e164.slice(-4)}`;
}

/** Opt-out words accepted in an inbound WhatsApp message (case-insensitive, trimmed). */
export const WHATSAPP_OPT_OUT_WORDS = ['stop', 'unsubscribe', 'إيقاف', 'ايقاف', 'الغاء', 'إلغاء', 'الغاء الاشتراك', 'إلغاء الاشتراك'];
