import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from './ui/Button';
export default function CursorPager({ shown, total, page, pageKnown=true, cursor, nextCursor, canPrevious, busy, error, onNext, onPrevious, onFirst }: {
  shown: number; total?: number | null; page: number; cursor: string; nextCursor?: string | null;
  pageKnown?:boolean;canPrevious: boolean; busy: boolean; error?: boolean; onNext: () => void; onPrevious: () => void; onFirst: () => void;
}) {
  return <footer className="card p-3 flex flex-wrap items-center justify-between gap-3" dir="rtl">
    <span role="status">المعروض: {shown}{total != null ? ` · الإجمالي: ${total}` : ''} · {pageKnown?`صفحة ${page}`:'صفحة مشاركة بالمؤشر'}</span>
    <nav aria-label="صفحات النتائج" className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" type="submit" aria-label="الصفحة السابقة" disabled={busy || !canPrevious} onClick={onPrevious}><ChevronRight size={16}/> السابقة</Button>
      <Button variant="ghost" type="submit" aria-label="الصفحة التالية" disabled={busy || !!error || !nextCursor || nextCursor === cursor} onClick={onNext}>التالية <ChevronLeft size={16}/></Button>
      {(!!cursor||page>1) && <Button variant="ghost" type="submit" disabled={busy} onClick={onFirst}>العودة للبداية</Button>}
    </nav>
    {!!cursor && !canPrevious && <p className="text-xs muted w-full">هذا رابط صفحة بالمؤشر. يمكنك متابعة النتائج أو العودة للبداية؛ لم يُحمّل سجل الصفحات السابقة.</p>}
    {!!nextCursor && nextCursor === cursor && <p role="alert" className="text-xs w-full">لم يتقدم مؤشر النتائج. حدّث القائمة قبل المتابعة.</p>}
  </footer>;
}
