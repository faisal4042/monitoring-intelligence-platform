/** Reporting Center client types (API: /api/v1/reports). */
export type ColumnType = 'text' | 'id' | 'int' | 'number' | 'datetime' | 'minutes' | 'bool';
export interface CatalogColumn { key: string; ar: string; en: string; type: ColumnType; group: string; default: boolean; allowed: boolean }
export interface CatalogType {
  key: string; ar: string; en: string; section: string; descriptionAr: string; dateLabelAr: string; aggregated: boolean;
  filters: string[]; available: boolean; reason: string | null; columns: CatalogColumn[];
}
export interface Catalog {
  schemaVersion: string; timezone: string; ticketsActivated: boolean;
  /** 0047 tables exist (history, templates, cancel). Older servers omit it: fall back to exportsActivated. */
  reportTablesReady?: boolean;
  /** Creating/retrying exports is allowed (tables + REPORT_EXPORTS_ENABLED on the server). */
  exportsActivated: boolean;
  /** Creating/activating schedules is allowed (tables + REPORT_SCHEDULES_ENABLED on the server). */
  schedulesActivated?: boolean;
  canExport: boolean; canSchedule: boolean; canShareTemplates: boolean; formats: ExportFormat[];
  types: CatalogType[]; unavailable: Array<{key: string; ar: string; section: string; reasonAr: string}>;
}
export type ExportFormat = 'xlsx' | 'csv' | 'tsv' | 'json' | 'jsonl';
export const tablesReady = (c: Catalog) => c.reportTablesReady ?? c.exportsActivated;
export const EXPORTS_OFF_TEXT = 'تصدير التقارير معطل حاليًا على هذا الخادم. المعاينة متاحة للقراءة فقط.';
export const SCHEDULES_OFF_TEXT = 'جدولة التقارير معطلة حاليًا على هذا الخادم؛ لا يمكن إنشاء جدولة أو تفعيلها.';
export interface ReportFilters { program?: string[]; channel?: string[]; status?: string[]; assignee?: string[]; intent?: string[]; sentiment?: string[]; section?: string[]; review?: boolean }
export interface ReportRequest { type: string; period: {range?: string; from?: string; to?: string}; filters: ReportFilters; columns: string[]; headerLang: 'ar' | 'en' }
export interface ExportOptions { format: ExportFormat; jsonMode?: 'flat' | 'structured'; zip?: boolean }
export interface ExportRow {
  id: string; report_type: string; format: ExportFormat; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  rows_written: string | number; rows_estimate: string | number | null; file_name: string | null; file_bytes: string | number | null; parts: number | null;
  error: string | null; created_at: string; started_at: string | null; finished_at: string | null; expires_at: string | null; attempts: number;
  cancel_requested: boolean; requested_by_name: string; is_owner: boolean; downloads: number;
}
export interface TemplateRow { id: string; name: string; report_type: string; visibility: 'private' | 'shared'; version: number; definition: {request: ReportRequest; options: ExportOptions}; updated_at: string; is_owner: boolean; owner_name: string }
export interface ScheduleRow { id: string; name: string; template_name: string; cadence: 'daily' | 'weekly' | 'monthly'; run_at_local: string; weekday: number | null; monthday: number | null; format: ExportFormat; is_active: boolean; next_run_at: string; last_run_at: string | null; failure_count: number; runs: number; last_error: string | null }

export const SECTIONS: Array<{key: string; ar: string}> = [
  {key: 'tickets', ar: 'تقارير التذاكر'}, {key: 'messages', ar: 'تقارير الرسائل'}, {key: 'activity', ar: 'سجل نشاط التذاكر'},
  {key: 'queue', ar: 'تقارير الطابور'}, {key: 'agents', ar: 'تقارير الموظفين'}, {key: 'performance', ar: 'الأداء وSLA'},
  {key: 'classifications', ar: 'تقارير التصنيفات'}, {key: 'monitoring', ar: 'تقارير الرصد'},
];
export const FORMAT_LABELS: Record<ExportFormat, string> = {xlsx: 'Excel (XLSX)', csv: 'CSV (UTF-8 BOM)', tsv: 'TSV', json: 'JSON', jsonl: 'JSONL'};
export const EXPORT_STATUS: Record<ExportRow['status'], {label: string; tone: string}> = {
  queued: {label: 'بالانتظار', tone: 'muted'}, running: {label: 'قيد الإنشاء', tone: 'info'}, succeeded: {label: 'جاهز', tone: 'ok'},
  failed: {label: 'فشل', tone: 'bad'}, cancelled: {label: 'ملغى', tone: 'muted'}, expired: {label: 'منتهي الصلاحية', tone: 'muted'},
};
export const FILTER_LABELS: Record<string, string> = {
  program: 'البرامج', channel: 'القنوات', status: 'الحالات', assignee: 'الموظفون', intent: 'نوع التفاعل', sentiment: 'المشاعر', topic: 'الموضوع', section: 'قسم الطابور', review: 'تحتاج مراجعة',
};
export const PERIOD_PRESETS: Array<{key: string; ar: string}> = [
  {key: 'today', ar: 'اليوم'}, {key: 'yesterday', ar: 'أمس'}, {key: '7d', ar: 'آخر 7 أيام'}, {key: '30d', ar: 'آخر 30 يومًا'},
  {key: 'this_month', ar: 'هذا الشهر'}, {key: 'last_month', ar: 'الشهر الماضي'}, {key: 'all', ar: 'كل الفترات'}, {key: 'custom', ar: 'فترة مخصصة'},
];
export const FILTER_OPTIONS: Record<string, Array<{value: string; ar: string}>> = {
  channel: [['x_dm', 'رسائل إكس الخاصة'], ['x_mention', 'منشور إكس عام'], ['x_reply', 'رد على إكس'], ['facebook_inbox', 'رسائل فيسبوك'], ['facebook_comment', 'تعليق فيسبوك']].map(([value, ar]) => ({value, ar})),
  ticketStatus: [['open', 'مفتوحة'], ['assigned', 'مسندة'], ['in_progress', 'قيد المعالجة'], ['pending', 'معلقة'], ['escalated', 'مصعّدة'], ['resolved', 'محلولة'], ['closed', 'مغلقة']].map(([value, ar]) => ({value, ar})),
  queueStatus: [['new', 'غير مسندة'], ['assigned', 'مسندة'], ['in_progress', 'قيد المعالجة'], ['escalated', 'مصعّدة'], ['completed', 'مكتملة']].map(([value, ar]) => ({value, ar})),
  intent: [['complaint', 'شكوى'], ['inquiry', 'استفسار'], ['suggestion', 'اقتراح'], ['praise', 'إشادة'], ['request', 'طلب'], ['issue', 'مشكلة'], ['experience', 'تجربة'], ['news', 'خبر'], ['warning', 'تحذير'], ['other', 'أخرى']].map(([value, ar]) => ({value, ar})),
  sentiment: [['positive', 'إيجابي'], ['neutral', 'محايد'], ['negative', 'سلبي'], ['very_negative', 'سلبي جدًا'], ['very_positive', 'إيجابي جدًا']].map(([value, ar]) => ({value, ar})),
  section: [['general', 'عام'], ['influencer', 'مؤثرين'], ['story', 'قصص']].map(([value, ar]) => ({value, ar})),
};
