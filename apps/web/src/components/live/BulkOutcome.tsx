import { bulkOutcome, type BulkItemResult } from '../../lib/bulk-outcome';

export default function BulkOutcome({ ids, results, onRetry, busy = false }: {
  ids: readonly string[]; results: readonly BulkItemResult[]; onRetry: (ids: string[]) => void; busy?: boolean;
}) {
  const outcome = bulkOutcome(ids, results);
  return <div aria-live="polite" className="space-y-2">
    <p>نجح: {outcome.successful.length} · فشل: {outcome.failed.length} · نتيجة غير معروفة: {outcome.unknown.length}</p>
    {!!outcome.unknown.length && <p role="alert">لم تصل نتيجة للعناصر: {outcome.unknown.join('، ')}. تحقق من حالتها قبل أي محاولة جديدة لتجنب تكرار التنفيذ.</p>}
    {!!outcome.failed.length && <button className="btn-ghost" disabled={busy} onClick={() => onRetry(outcome.failed)}>معاينة الفاشل فقط ({outcome.failed.length})</button>}
    <p className="text-xs muted">العناصر الناجحة مستبعدة من إعادة المحاولة. إعادة المحاولة تبدأ بمعاينة جديدة.</p>
  </div>;
}
