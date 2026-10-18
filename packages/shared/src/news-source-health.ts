/** Evidence-based, read-only source diagnostics. Silence is never a collection failure. */
export interface SourceEvidence {
  is_active: boolean; collection_attempt_at: string | null; collection_success_at: string | null;
  collection_status: string | null; collection_error: string | null; articles_24h: number;
}
export type SourceState = 'healthy' | 'troubled' | 'paused' | 'review' | 'unknown';
export const SOURCE_STATE_LABELS: Record<SourceState, string> = {
  healthy: 'سليم', troubled: 'متعثر', paused: 'متوقف إداريًا', review: 'يحتاج مراجعة', unknown: 'بيانات غير كافية',
};
export function httpStatusFromError(error: string | null): number | null {
  const match = error?.match(/(?:HTTP(?:\s+status)?|status(?:\s+code)?|الحالة|حالة)\s*[:=]?\s*([45]\d{2})\b/i);
  return match ? Number(match[1]) : null;
}
export function sourceIssue(error: string | null) {
  const status = httpStatusFromError(error);
  if (status === 403) return { code: 'http_403', reason: 'رفض وصول HTTP 403؛ سبب الحماية غير مثبت', recommendation: 'أوقف إعادة المحاولة؛ راجع سياسة الوصول وRSS/Sitemap المصرح به دون تجاوز الحماية.' };
  if (status === 404) return { code: 'http_404', reason: 'الرابط أعاد HTTP 404', recommendation: 'تحقق من الرابط الرسمي في اختبار منفصل؛ لا تستبدله دون دليل ومراجعة.' };
  if (status === 429) return { code: 'http_429', reason: 'تقييد معدل الطلبات HTTP 429', recommendation: 'احترم Retry-After وقلل معدل الفحص في تعديل معتمد لاحقًا.' };
  if (status && status >= 500) return { code: 'http_5xx', reason: `خطأ خادم HTTP ${status}`, recommendation: 'راقب عودة الخدمة؛ استخدم تراجعًا زمنيًا في تعديل معتمد لاحقًا.' };
  if (status) return { code: 'http_4xx', reason: `رفض طلب HTTP ${status}؛ السبب الجذري غير مثبت`, recommendation: 'راجع سياسة الوصول وصيغة الطلب قبل أي تعديل؛ لا تتجاوز قيود المصدر.' };
  if (/timeout|مهلة|ETIMEDOUT/i.test(error ?? '')) return { code: 'timeout', reason: 'انتهاء مهلة الطلب', recommendation: 'راجع زمن الاستجابة والسجل؛ لا ترفع المهلة أو تغير الرابط دون اختبار مستقل.' };
  if (/DNS|ENOTFOUND/i.test(error ?? '')) return { code: 'dns', reason: 'تعذر حل اسم النطاق', recommendation: 'راجع النطاق وDNS محليًا ثم تحقق رسميًا بعد الموافقة.' };
  if (/no_text|too_short|لم.*متن/i.test(error ?? '')) return { code: 'empty_body', reason: 'لم يُقبل متن المقال', recommendation: 'راجع المحددات وطول النص في fixtures؛ حافظ على بيانات RSS الأصلية.' };
  if (/unexpected_language/i.test(error ?? '')) return { code: 'language', reason: 'لغة نتيجة الاستخراج غير متوقعة', recommendation: 'قارن لغة المصدر بالنتيجة قبل تعديل قواعد الاستخراج.' };
  if (/لم يُعثر على روابط|تعذّر العثور على خريطة|ليس RSS أو Atom/i.test(error ?? '')) return { code: 'discovery_structure', reason: 'لم يتحقق مسار اكتشاف صالح من المحتوى المستلم', recommendation: 'راجع بنية الخلاصة أو محددات الروابط في fixtures؛ لا يثبت هذا توقف الموقع عن النشر.' };
  return { code: 'unclassified', reason: error ? 'إخفاق مسجل؛ السبب الجذري غير مثبت' : 'لا يوجد خطأ مسجل', recommendation: 'راجع سجل المحاولة قبل أي تغيير.' };
}
export function classifySource(s: SourceEvidence, now = Date.now()) {
  if (!s.is_active) return { state: 'paused' as SourceState, priority: 4, reason: 'التفعيل الإداري متوقف', recommendation: 'لا تغير التفعيل دون قرار إداري.' };
  if (!s.collection_attempt_at) return { state: 'unknown' as SourceState, priority: 2, reason: 'لا توجد مهمة جمع مسجلة', recommendation: 'راجع نطاق الجدولة؛ الحالة الافتراضية ليست دليل نجاح.' };
  if (s.collection_status === 'failed') {
    const issue = sourceIssue(s.collection_error);
    return { state: (issue.code === 'discovery_structure' ? 'review' : 'troubled') as SourceState, priority: issue.code === 'discovery_structure' ? 1 : 0, ...issue };
  }
  const age = now - Date.parse(s.collection_attempt_at);
  if (!Number.isFinite(age) || age > 24 * 3_600_000) return { state: 'review' as SourceState, priority: 1, reason: 'لا توجد محاولة جمع حديثة خلال 24 ساعة', recommendation: 'راجع نطاق الجدولة وآخر تشغيل؛ لا يعني ذلك تعطل الموقع.' };
  if (s.collection_status === 'running') return { state: 'review' as SourceState, priority: 1, reason: 'مهمة جمع لم تسجل نتيجة نهائية بعد', recommendation: 'راجع زمن المهمة؛ لا تفترض فشل المصدر.' };
  if (s.collection_status !== 'success') return { state: 'unknown' as SourceState, priority: 2, reason: 'نتيجة الجمع غير معروفة', recommendation: 'راجع السجل المتاح.' };
  return { state: 'healthy' as SourceState, priority: 3, reason: s.collection_error ? 'جمع ناجح مع تحذير من مسار آخر' : s.articles_24h ? 'آخر جمع مسجل ناجح' : 'جمع ناجح دون أخبار جديدة خلال 24 ساعة', recommendation: 'لا يلزم تدخل بسبب غياب أخبار جديدة وحده.' };
}
