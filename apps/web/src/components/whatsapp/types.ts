import { WHATSAPP_PERMISSIONS as W, type WhatsAppIntegrationState } from '@mip/shared';
import type { BadgeTone } from '../ui/Badge';

export interface WaSettings {
  state: WhatsAppIntegrationState; enabled: boolean; paused: boolean; serverSendingEnabled: boolean;
  wabaId: string | null; phoneNumberId: string | null; apiVersion: string | null;
  accessTokenSet: boolean; accessTokenLast4: string | null; appSecretSet: boolean; verifyTokenSet: boolean;
  displayPhoneNumber: string | null; verifiedName: string | null; webhookUrl: string;
  webhookVerifiedAt: string | null; lastWebhookAt: string | null; lastVerifiedAt: string | null; lastVerifiedOk: boolean | null;
  lastErrorCode: string | null; lastErrorMessage: string | null; lastErrorAt: string | null;
  limits: { maxPerMinute: number; dailyLimit: number | null; monthlyLimit: number | null; maxAttempts: number; backoffBaseSeconds: number; backoffMaxSeconds: number; retentionMinutes: number };
  thresholds: { overdueDigestMinutes: number; negativeMinFollowers: number; newsFailuresPerHour: number; quotaAlertPercent: number };
  costEstimate: { perMessage: number; currency: string | null } | null;
}
export interface WaStats {
  today_total: number; today_accepted: number; today_failed: number; month_accepted: number; month_failed: number; month_delivered: number; queued: number;
  limits: { daily: number | null; monthly: number | null; perMinute: number };
  costEstimate: { amount: number; currency: string | null; basis: string } | null;
}
export interface WaEvent {
  key: string; group: 'monitoring' | 'queue' | 'operations'; label: string; availability: 'available' | 'partial' | 'unavailable';
  note: string; optional: boolean; enabled: boolean; templateId: string | null; templateName: string | null; templateStatus: string | null; routes: number;
}
export interface WaTemplate {
  id: string; name: string; language: string; event_type: string | null; category: string; body_preview: string; variables: string[];
  meta_status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled'; meta_template_id: string | null; meta_reason: string | null;
  last_synced_at: string | null; is_active: boolean;
}
export interface WaRecipient {
  id: string; user_id: string; full_name: string; email: string; role_name_ar: string; phone: string; countryCode: string;
  is_supervisor: boolean; is_active: boolean; user_active: boolean; opt_in_status: 'pending' | 'opted_in' | 'opted_out';
  opt_in_at: string | null; opt_in_method: string | null; opted_out_at: string | null; opt_out_source: string | null; disabled_alerts: number;
}
export interface WaRoute { id: string; event_type: string; audience: string; role_key: string | null; role_name: string | null; program_id: string | null; program_name: string | null; recipient_id: string | null; recipient_name: string | null }
export interface WaMessage {
  id: string; event_type: string; status: string; attempts: number; template_name: string; template_language: string;
  error_class: string | null; last_error_code: string | null; last_error_message: string | null; meta_message_id: string | null; is_test: boolean;
  created_at: string; accepted_at: string | null; sent_at: string | null; delivered_at: string | null; read_at: string | null; failed_at: string | null; cancelled_at: string | null;
  program_id: string | null; program_name: string | null; recipient_name: string; recipient_phone: string;
}

export const STATE_TONE: Record<WhatsAppIntegrationState, BadgeTone> = { not_configured: 'neutral', ready: 'success', disabled: 'neutral', paused: 'warning', error: 'danger' };
export const TEMPLATE_TONE: Record<WaTemplate['meta_status'], BadgeTone> = { draft: 'neutral', pending: 'info', approved: 'success', rejected: 'danger', paused: 'warning', disabled: 'danger' };
export const STATUS_TONE: Record<string, BadgeTone> = { queued: 'neutral', processing: 'info', accepted: 'info', sent: 'accent', delivered: 'success', read: 'success', failed: 'danger', cancelled: 'neutral' };
export const OPT_IN_LABEL: Record<WaRecipient['opt_in_status'], { label: string; tone: BadgeTone }> = {
  pending: { label: 'بانتظار الموافقة', tone: 'warning' }, opted_in: { label: 'وافق على الاستقبال', tone: 'success' }, opted_out: { label: 'ألغى الاشتراك', tone: 'neutral' },
};
export const AUDIENCE_LABELS: Record<string, string> = {
  assignee: 'الموظف المُسند إليه', supervisors: 'المشرفون', role: 'حسب الدور', program_team: 'فريق البرنامج', recipient: 'مستلم محدد',
};
export const ERROR_CLASS_LABELS: Record<string, string> = {
  transient: 'خطأ مؤقت', rate_limited: 'تجاوز حد الإرسال', permanent: 'خطأ نهائي', config: 'خطأ في الإعداد', uncertain: 'نتيجة غير مؤكدة', policy: 'سياسة أو موافقة',
};

export function waAccess(permissions: readonly string[]) {
  const has = (p: string) => permissions.includes(p);
  return {
    any: Object.values(W).some(has),
    view: has(W.VIEW) || has(W.CONFIGURE) || has(W.TOGGLE),
    configure: has(W.CONFIGURE), toggle: has(W.TOGGLE), recipients: has(W.RECIPIENTS),
    templates: has(W.TEMPLATES), log: has(W.LOG), test: has(W.TEST_SEND),
  };
}
export type WaAccess = ReturnType<typeof waAccess>;
