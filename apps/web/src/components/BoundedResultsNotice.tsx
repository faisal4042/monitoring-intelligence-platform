/** Timestamp-only API cursors skip tied records. Do not advertise complete pagination. */
export default function BoundedResultsNotice({shown, limit, unsupportedPosition}: {shown: number; limit: number; unsupportedPosition?: boolean}) {
  return <div className="card p-3 text-sm space-y-1" role="status">
    <p>المعروض: <span className="num">{shown}</span> نتيجة، بحد أقصى <span className="num">{limit}</span> في هذا العرض.</p>
    <p className="muted">الإجمالي غير متاح. قد توجد نتائج إضافية؛ التصفح التالي متوقف لأن مؤشر الوقت الحالي قد يتجاوز سجلات متساوية التوقيت. قلّص نطاق البرنامج والفترة، أو استخدم البحث المتقدم مع مراعاة حدوده.</p>
    {unsupportedPosition && <p>موضع الصفحة أو المؤشر في الرابط لم يُطبّق؛ المعروض هو بداية النتائج المطابقة للفلاتر.</p>}
  </div>;
}
