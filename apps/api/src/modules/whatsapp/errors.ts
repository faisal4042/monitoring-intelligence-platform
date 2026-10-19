/**
 * Classifies WhatsApp Cloud API failures so the dispatcher knows whether to
 * retry. Codes follow Meta's published Cloud API / Graph API error reference;
 * an unknown code falls back on the HTTP status (5xx → transient, 4xx → permanent).
 *
 *  transient     Meta or the network failed for a while: retry with backoff.
 *  rate_limited  Throughput or pair limit hit: retry later, and stop this batch.
 *  permanent     This message can never succeed as built (bad number, bad parameter): do not retry.
 *  config        The integration itself is wrong (token, permissions, template): do not retry; flag settings.
 *  policy        Meta refused for policy/consent reasons (opt-out, blocked account): do not retry.
 *  uncertain     The request may have reached Meta (timeout after sending): never retried automatically,
 *                because a retry could deliver the same alert twice.
 */
export type ErrorClass = 'transient' | 'rate_limited' | 'permanent' | 'config' | 'uncertain' | 'policy';

export interface MetaErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string; error_data?: { details?: string } };
}

export interface ClassifiedError {
  class: ErrorClass;
  code: string;
  /** Short Arabic explanation for the log and the settings page (no secrets, no raw payload). */
  message: string;
  httpStatus?: number;
  /** Seconds Meta asked us to wait, when it said so. */
  retryAfterSeconds?: number;
}

const RATE_LIMIT = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const TRANSIENT = new Set([1, 2, 131000, 131016, 133004]);
const CONFIG = new Set([
  10, 190, 200, 3, 131005, 131031, 131037, 133010, 135000,
  132000, 132001, 132005, 132007, 132012, 132015, 132016, 132068, 132069,
]);
const POLICY = new Set([368, 131047, 131049, 131050, 131053]);
const PERMANENT = new Set([100, 131008, 131009, 131021, 131026, 131030, 131042, 131051, 131052]);

const MESSAGES: Record<number, string> = {
  190: 'رمز الوصول غير صالح أو منتهي الصلاحية',
  10: 'التطبيق لا يملك صلاحية واتساب المطلوبة',
  200: 'التطبيق لا يملك صلاحية واتساب المطلوبة',
  100: 'معامل غير صالح في الطلب',
  131005: 'تم رفض الوصول: تحقق من صلاحيات الرمز',
  131008: 'معامل مطلوب مفقود',
  131009: 'قيمة معامل غير صالحة',
  131021: 'لا يمكن الإرسال إلى رقم المرسل نفسه',
  131026: 'تعذّر تسليم الرسالة إلى هذا الرقم',
  131030: 'الرقم غير موجود في قائمة الأرقام المسموح بها (حساب تجريبي)',
  131031: 'حساب الأعمال مقفل',
  131042: 'مشكلة في وسيلة الدفع لحساب الأعمال',
  131047: 'انتهت نافذة الـ24 ساعة؛ يلزم قالب معتمد',
  131049: 'امتنعت Meta عن التسليم للحفاظ على جودة التواصل',
  131050: 'المستلم أوقف استقبال هذا النوع من الرسائل',
  131051: 'نوع رسالة غير مدعوم',
  131056: 'تجاوز حد الرسائل لنفس المستلم',
  130429: 'تجاوز حد معدل الإرسال',
  131048: 'تقييد إرسال بسبب الجودة',
  80007: 'تجاوز حد معدل حساب الأعمال',
  132000: 'عدد متغيرات القالب لا يطابق القالب المعتمد',
  132001: 'القالب غير موجود أو لغته غير صحيحة',
  132005: 'نص القالب بعد التعبئة أطول من المسموح',
  132007: 'محتوى القالب يخالف سياسات Meta',
  132012: 'صيغة متغيرات القالب غير صحيحة',
  132015: 'القالب موقوف من Meta',
  132016: 'القالب معطل من Meta',
  133010: 'رقم الهاتف غير مسجّل في واتساب للأعمال',
  368: 'حساب الأعمال محظور مؤقتًا لمخالفة السياسات',
  131000: 'خطأ عام من Meta',
  131016: 'الخدمة غير متاحة مؤقتًا',
  1: 'خطأ مؤقت في واجهة Meta',
  2: 'الخدمة غير متاحة مؤقتًا',
};

/** Classifies an HTTP response from the Graph API that was not a success. */
export function classifyMetaError(httpStatus: number, body: MetaErrorBody | null, retryAfterHeader?: string | null): ClassifiedError {
  const code = body?.error?.code;
  const retryAfter = retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined;
  const message = (code !== undefined && MESSAGES[code]) || `رفضت Meta الطلب (HTTP ${httpStatus})`;
  const codeText = code !== undefined ? String(code) : `http_${httpStatus}`;
  let cls: ErrorClass;
  if (code !== undefined && RATE_LIMIT.has(code)) cls = 'rate_limited';
  else if (code !== undefined && CONFIG.has(code)) cls = 'config';
  else if (code !== undefined && POLICY.has(code)) cls = 'policy';
  else if (code !== undefined && PERMANENT.has(code)) cls = 'permanent';
  else if (code !== undefined && TRANSIENT.has(code)) cls = 'transient';
  else if (httpStatus === 429) cls = 'rate_limited';
  else if (httpStatus === 401 || httpStatus === 403) cls = 'config';
  else if (httpStatus >= 500) cls = 'transient';
  else cls = 'permanent';
  return { class: cls, code: codeText, message, httpStatus, retryAfterSeconds: retryAfter };
}

/** Socket errors that prove the request never left this server. */
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED']);

/**
 * A network failure. If it proves the request never reached Meta (DNS, refused connection): transient.
 * Otherwise (reset, timeout mid-request) Meta may have accepted it: uncertain, so it is not resent.
 */
export function classifyNetworkError(err: unknown): ClassifiedError {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (err as { code?: string } | null)?.code;
  if (code && NOT_SENT.has(code)) return { class: 'transient', code: code.toLowerCase(), message: 'تعذّر الاتصال بخوادم Meta' };
  const name = err instanceof Error ? err.name : '';
  const timedOut = name === 'TimeoutError' || name === 'AbortError';
  return { class: 'uncertain', code: timedOut ? 'timeout' : (code ?? 'network').toLowerCase(), message: 'انقطع الاتصال بعد إرسال الطلب؛ قد تكون الرسالة وصلت إلى Meta' };
}

export const isRetryable = (c: ErrorClass) => c === 'transient' || c === 'rate_limited';
