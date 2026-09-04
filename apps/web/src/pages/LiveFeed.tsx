import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Post } from '../lib/types';
import { Radio } from 'lucide-react';
import AuthorHistoryModal from '../components/AuthorHistoryModal';
import PostCard from '../components/PostCard';
import Lightbox from '../components/Lightbox';

const REL_OPTIONS: Record<string, string> = {
  relevant: 'مرتبط', irrelevant: 'غير مرتبط', advertisement: 'إعلان', spam: 'spam', unknown: 'غير محدد',
};
const SENT_OPTIONS: Record<string, string> = {
  very_positive: 'إيجابي جداً', positive: 'إيجابي', neutral: 'محايد', negative: 'سلبي', very_negative: 'سلبي جداً',
};

export default function LiveFeed() {
  const [relevance, setRelevance] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [influencersOnly, setInfluencersOnly] = useState(false);
  const [q, setQ] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const [historyAuthorId, setHistoryAuthorId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['posts', relevance, sentiment, influencersOnly, q],
    queryFn: () => {
      const p = new URLSearchParams({ limit: '50' });
      if (relevance) p.set('relevance', relevance);
      if (sentiment) p.set('sentiment', sentiment);
      if (influencersOnly) p.set('influencersOnly', 'true');
      if (q) p.set('q', q);
      return api.get<{ items: Post[]; nextCursor: string | null }>(`/posts?${p}`);
    },
    // X delivers matching posts to the backend continuously; keep the browser
    // close to that stream without exposing X credentials client-side.
    refetchInterval: 5_000,
  });

  const { data: whyData } = useQuery({
    queryKey: ['why', why],
    queryFn: () => api.get<Record<string, unknown>>(`/posts/${why}/why-collected`),
    enabled: !!why,
  });

  return (
    <div className="space-y-4">
      <div className="page-heading">
        <div>
          <h1 className="flex items-center gap-2.5"><Radio size={22} className="text-brand-500" /> الرصد المباشر</h1>
          <p>كل الفلاتر تُطبَّق على الخادم — المتصفح لا يستقبل الجدول كاملاً</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className="input max-w-40" value={relevance} onChange={(e) => setRelevance(e.target.value)}>
          <option value="">كل التصنيفات</option>
          {Object.entries(REL_OPTIONS).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
        </select>
        <select className="input max-w-40" value={sentiment} onChange={(e) => setSentiment(e.target.value)}>
          <option value="">كل المشاعر</option>
          {Object.entries(SENT_OPTIONS).map(([k, text]) => <option key={k} value={k}>{text}</option>)}
        </select>
        <input className="input max-w-64" placeholder="بحث في النص…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="flex items-center gap-1.5 text-sm px-1">
          <input type="checkbox" checked={influencersOnly} onChange={(e) => setInfluencersOnly(e.target.checked)} />
          العملاء المؤثرون فقط
        </label>
      </div>

      {isLoading && <div className="card p-8 text-center muted text-sm">جارٍ التحميل…</div>}

      {!isLoading && !data?.items?.length && (
        <div className="card p-10 text-center">
          <p className="muted">لا توجد منشورات بعد. شغّل عملية جمع من صفحة الاستعلامات.</p>
        </div>
      )}

      <div className="space-y-2">
        {(data?.items ?? []).map((p) => (
          <PostCard key={p.id} post={p} onWhy={setWhy} onHistory={setHistoryAuthorId} onLightbox={setLightboxUrl} />
        ))}
      </div>

      {why && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setWhy(null)}>
          <div className="card p-5 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold mb-1">لماذا جمعنا هذا المنشور؟</h3>
            <p className="text-xs muted mb-3">الاستعلام والإصدار والكلمات التي طابقت — أساس حلقة تحسين القاموس.</p>
            <pre className="text-xs p-3 rounded-lg overflow-auto max-h-96 whitespace-pre-wrap"
                 style={{ background: 'var(--surface-2)', direction: 'ltr', textAlign: 'left' }}>
              {JSON.stringify(whyData ?? {}, null, 2)}
            </pre>
            <div className="flex justify-end mt-4">
              <button className="btn-ghost" onClick={() => setWhy(null)}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {historyAuthorId && (
        <AuthorHistoryModal xAuthorId={historyAuthorId} onClose={() => setHistoryAuthorId(null)} />
      )}

      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
