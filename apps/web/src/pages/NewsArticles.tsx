import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { useAuth } from '../lib/auth';
import { PERMISSIONS } from '@mip/shared';
import { Newspaper, RefreshCw } from 'lucide-react';

interface Program { id: string; name_ar: string; color: string }

interface NewsArticle {
  id: string;
  url: string;
  title: string;
  description: string | null;
  image_url: string | null;
  author: string | null;
  published_at: string | null;
  effective_at: string;
  source_name: string;
  source_logo_url: string | null;
  source_weight: number;
  program_name: string | null;
  program_color: string | null;
  topic_name: string | null;
  matched_keyword: string | null;
  relevance_score: number;
  related_source_count: number;
  related_source_names: string[];
}

function decodeText(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[name.toLowerCase()] ?? entity);
}

export default function NewsArticles() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [programId, setProgramId] = useState('');
  const [days, setDays] = useState('180');

  const { data: programs } = useQuery({
    queryKey: ['programs'],
    queryFn: () => api.get<{ items: Program[] }>('/programs'),
  });

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['news-articles', programId, days],
    queryFn: () => api.get<{ items: NewsArticle[] }>(
      `/news/articles?limit=100&days=${days}${programId ? `&programId=${programId}` : ''}`,
    ),
    refetchInterval: 5 * 60 * 1000,
  });

  const articles = data?.items ?? [];
  const fetchNow = useMutation({
    mutationFn: () => api.post<{ queued: number }>('/news/articles/fetch-now', {}),
    onSuccess: () => {
      window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: ['news-articles'] }), 8_000);
    },
  });

  const refresh = () => {
    if (can(PERMISSIONS.NEWS_MANAGE_SOURCES)) fetchNow.mutate();
    else void refetch();
  };

  return (
    <div className="space-y-5" dir="rtl">
      <section className="rounded-2xl border p-5 sm:p-6" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold text-emerald-600">
              <span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" /></span>
              تحديث حي كل 5 دقائق
            </div>
            <h1 className="flex items-center gap-2.5 text-2xl font-black sm:text-3xl"><Newspaper size={24} className="text-brand-500" /> الأخبار العقارية</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 muted">أخبار مرتبطة مباشرة بالهيئة وبرامجها وخدماتها فقط، مرتبة حسب وقت النشر ومصنفة تلقائيًا حسب البرنامج والموضوع.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select className="input min-w-44" value={programId} onChange={(event) => setProgramId(event.target.value)} aria-label="تصفية حسب البرنامج">
              <option value="">جميع البرامج</option>
              {programs?.items.map((program) => <option key={program.id} value={program.id}>{program.name_ar}</option>)}
            </select>
            <select className="input" value={days} onChange={(event) => setDays(event.target.value)} aria-label="الفترة الزمنية">
              <option value="7">آخر 7 أيام</option>
              <option value="30">آخر 30 يومًا</option>
              <option value="90">آخر 3 أشهر</option>
              <option value="180">آخر 6 أشهر</option>
              <option value="365">آخر سنة</option>
            </select>
            <button className="btn-primary" onClick={refresh} disabled={isFetching || fetchNow.isPending}>
              <RefreshCw size={15} className={isFetching || fetchNow.isPending ? 'animate-spin' : ''} />
              {fetchNow.isPending ? 'جارٍ طلب الأخبار…' : isFetching ? 'جارٍ التحديث…' : 'سحب الأخبار الآن'}
            </button>
          </div>
        </div>
      </section>

      {isLoading ? (
        <div className="rounded-2xl border p-12 text-center muted" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>جارٍ جلب الأخبار الدقيقة…</div>
      ) : isError ? (
        <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-10 text-center text-red-600">تعذر جلب الأخبار. <button className="underline" onClick={() => void refetch()}>إعادة المحاولة</button></div>
      ) : articles.length === 0 ? (
        <div className="rounded-2xl border p-12 text-center" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <div className="text-lg font-bold">لا توجد أخبار مطابقة في هذه الفترة</div>
          <p className="mt-2 text-sm muted">لم يُرصد خبر يرتبط مباشرة بالهيئة أو أحد برامجها في الفترة المحددة.</p>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {articles.map((article) => (
            <article key={article.id} className="group overflow-hidden rounded-2xl border transition hover:-translate-y-0.5 hover:shadow-lg" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
              <a href={article.url} target="_blank" rel="noreferrer" className="flex h-full min-h-48 gap-4 p-4 sm:p-5">
                {article.image_url && <img src={article.image_url} alt="" loading="lazy" className="h-28 w-28 shrink-0 rounded-xl object-cover sm:h-32 sm:w-36" />}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-bold text-blue-600">{article.source_name}</span>
                    {article.related_source_count > 1 && <span className="rounded-full bg-blue-500/10 px-2 py-1 font-bold text-blue-600">+{article.related_source_count - 1} مصادر</span>}
                    <span className="muted">•</span>
                    <time className="muted">{fmtRelative(article.published_at ?? article.effective_at)}</time>
                    {article.program_name && (
                      <span className="rounded-full px-2 py-1 font-bold" style={{ color: article.program_color ?? '#2563eb', background: `${article.program_color ?? '#2563eb'}18` }}>{article.program_name}</span>
                    )}
                    {article.topic_name && <span className="rounded-full bg-slate-500/10 px-2 py-1 muted">{article.topic_name}</span>}
                  </div>
                  <h2 className="line-clamp-3 text-lg font-black leading-7 transition group-hover:text-blue-600">{decodeText(article.title)}</h2>
                  {article.description && <p className="mt-2 line-clamp-2 text-sm leading-6 muted">{decodeText(article.description.replace(/<[^>]*>/g, ' '))}</p>}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-xs">
                    <span className="muted">{article.matched_keyword ? `مطابق: ${article.matched_keyword}` : 'خبر عقاري مصنف'}</span>
                    <span className="font-bold text-blue-600">فتح الخبر ↗</span>
                  </div>
                </div>
              </a>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
