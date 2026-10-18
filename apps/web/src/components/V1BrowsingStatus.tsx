import {ApiError} from '../lib/api';

export function browsingErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'INVALID_CURSOR') return 'انتهت صلاحية رابط التصفح أو لا يطابق المستخدم والفلاتر الحالية. ابدأ تصفحًا جديدًا.';
  if (error instanceof ApiError && error.code === 'NEWS_GROUPS_NOT_READY') return 'الأخبار غير جاهزة للتصفح؛ لم تكتمل تهيئة العناوين في الخادم. لم تُخفَ نتائج ناقصة. أعد المحاولة بعد اكتمال التهيئة.';
  if (error instanceof ApiError && error.status === 403) return 'لا تملك صلاحية قراءة هذه النتائج حاليًا.';
  return 'تعذر تحميل النتائج. يمكنك إعادة محاولة القراءة أو بدء تصفح جديد.';
}
export default function V1BrowsingStatus({error, hasMore, busy, onRestart, onRetry}: {
  error?: unknown; hasMore?: boolean; busy: boolean; onRestart: () => void; onRetry: () => void;
}) {
  if (error) return <div className="card p-4 space-y-3" role="alert">
    <p>{browsingErrorMessage(error)}</p>
    <div className="flex flex-wrap gap-2">
      <button className="btn-ghost" disabled={busy} onClick={onRestart}>بدء تصفح جديد</button>
      {!(error instanceof ApiError && error.code === 'INVALID_CURSOR') && <button className="btn-ghost" disabled={busy} onClick={onRetry}>إعادة المحاولة</button>}
    </div>
  </div>;
  return <div className="text-xs muted space-y-1" role="status">
    <p>قد تتغير النتائج أثناء التصفح؛ لا يمثل العرض لقطة ثابتة. تحديث العرض يبدأ جولة جديدة من البداية.</p>
    {busy ? <p>جارٍ تحميل النتائج الحالية…</p> : hasMore === false ? <p>نهاية النتائج المتاحة في هذه الجولة.</p> : hasMore === undefined ? <p>لم يؤكد الخادم إمكانية متابعة النتائج.</p> : null}
  </div>;
}
