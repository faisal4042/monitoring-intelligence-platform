import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNum, fmtRelative } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import { Plus, Rss, X } from 'lucide-react';

interface NewsSource {
  id: string; program_id: string | null; program_name: string | null;
  name_ar: string; name_en: string | null; base_url: string;
  country: string | null; language: string;
  source_type: string; connector_type: string;
  rss_url: string | null; sitemap_url: string | null; api_url: string | null;
  source_weight: number; check_interval_minutes: number;
  is_active: boolean; crawl_allowed: boolean;
  health_state: 'healthy' | 'degraded' | 'failed';
  consecutive_failures: number; total_fetches: number; total_errors: number;
  last_checked_at: string | null;
}

interface DiscoveryResult {
  connectionOk: boolean; httpStatus: number | null; responseMs: number | null;
  detectedRssUrl: string | null; detectedAtomUrl: string | null;
  detectedSitemapUrl: string | null; detectedNewsSitemapUrl: string | null;
  robotsStatus: 'allowed' | 'disallowed' | 'unknown'; crawlAllowed: boolean;
  recommendedMethod: 'rss' | 'atom' | 'sitemap' | 'unknown';
  lastArticle: { title: string; publishedAt: string | null } | null;
  errors: string[];
}

const SOURCE_TYPES: Record<string, string> = {
  newspaper: 'صحيفة', news_site: 'موقع إخباري', government: 'حكومي',
  real_estate: 'عقاري', blog: 'مدونة', magazine: 'مجلة', other: 'أخرى',
};
const CONNECTOR_TYPES: Record<string, string> = {
  auto: 'اكتشاف تلقائي', rss: 'RSS', atom: 'Atom', api: 'API', sitemap: 'Sitemap', crawler: 'Crawler', manual: 'يدوي',
  unknown: 'غير معروف — أضف الرابط يدوياً',
};
const HEALTH: Record<string, { text: string; cls: string }> = {
  healthy: { text: 'سليم', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  degraded: { text: 'متدهور', cls: 'bg-amber-500/15 text-amber-600' },
  failed: { text: 'متعطل', cls: 'bg-red-500/15 text-red-600' },
};

function DiscoveryPanel({ discovery }: { discovery: DiscoveryResult }) {
  return (
    <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
      <div className="text-sm font-medium mb-1">نتيجة اختبار الاتصال</div>
      <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <div>الاتصال: <b className={discovery.connectionOk ? 'text-emerald-600' : 'text-red-600'}>{discovery.connectionOk ? 'ناجح' : 'فشل'}</b></div>
        <div>حالة HTTP: <span className="num">{discovery.httpStatus ?? '—'}</span></div>
        <div>RSS مكتشف: <span className="num" style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{discovery.detectedRssUrl ?? '—'}</span></div>
        <div>Atom مكتشف: <span className="num" style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{discovery.detectedAtomUrl ?? '—'}</span></div>
        <div>Sitemap مكتشف: <span className="num" style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{discovery.detectedSitemapUrl ?? '—'}</span></div>
        <div>News Sitemap مكتشف: <span className="num" style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>{discovery.detectedNewsSitemapUrl ?? '—'}</span></div>
        <div>robots.txt: {discovery.robotsStatus === 'allowed' ? 'يسمح' : discovery.robotsStatus === 'disallowed' ? 'يمنع' : 'غير معروف'}</div>
        <div>زمن الاستجابة: <span className="num">{discovery.responseMs ?? '—'}</span> ms</div>
        <div>الطريقة الموصى بها: <b>{CONNECTOR_TYPES[discovery.recommendedMethod] ?? discovery.recommendedMethod}</b></div>
        {discovery.lastArticle && <div className="sm:col-span-2">آخر عنصر موجود: {discovery.lastArticle.title}</div>}
      </div>
      {discovery.errors.length > 0 && (
        <ul className="text-xs text-amber-600 list-disc list-inside">
          {discovery.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

const emptyForm = {
  nameAr: '', nameEn: '', baseUrl: '', country: '', language: 'ar',
  sourceType: 'news_site', connectorType: 'auto',
  rssUrl: '', sitemapUrl: '', apiUrl: '',
  sourceWeight: 50, checkIntervalMinutes: 5,
};

export default function NewsSources() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canManage = can(PERMISSIONS.NEWS_MANAGE_SOURCES);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['news-sources'],
    queryFn: () => api.get<{ items: NewsSource[] }>('/news/sources'),
  });

  const testConnection = useMutation({
    mutationFn: (url: string) => api.post<DiscoveryResult>('/news/sources/test-connection', { url }),
    onSuccess: setDiscovery,
  });

  const [sourceResults, setSourceResults] = useState<Record<string, DiscoveryResult>>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const testExistingSource = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      setTestingSourceId(id);
      setSourceErrors((prev) => ({ ...prev, [id]: '' }));
      const result = await api.post<DiscoveryResult>(`/news/sources/${id}/test-connection`);
      return { id, result };
    },
    onSuccess: ({ id, result }) => {
      setSourceResults((prev) => ({ ...prev, [id]: result }));
      setTestingSourceId(null);
      // The check is now recorded on the source row itself (last_checked_at,
      // health state, and any newly-discovered rss/sitemap URL) — refetch so
      // the card reflects it instead of only showing the ephemeral panel.
      qc.invalidateQueries({ queryKey: ['news-sources'] });
    },
    onError: (err: unknown, { id }) => {
      setSourceErrors((prev) => ({ ...prev, [id]: err instanceof ApiError ? err.message : 'تعذّر اختبار الاتصال' }));
      setTestingSourceId(null);
    },
  });

  const createSource = useMutation({
    mutationFn: () => api.post('/news/sources', {
      ...form,
      nameEn: form.nameEn || undefined,
      country: form.country || undefined,
      rssUrl: form.rssUrl || undefined,
      sitemapUrl: form.sitemapUrl || undefined,
      apiUrl: form.apiUrl || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['news-sources'] });
      setShowForm(false);
      setForm(emptyForm);
      setDiscovery(null);
    },
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      isActive ? api.patch(`/news/sources/${id}`, { isActive: true }) : api.del(`/news/sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['news-sources'] }),
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><Rss size={22} className="text-brand-500" /> مصادر الأخبار</h1>
          <p className="text-sm muted">تسجيل واختبار المصادر فقط في هذه المرحلة — لا جلب دوري بعد</p>
        </div>
        {canManage && (
          <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? <><X size={15} /> إلغاء</> : <><Plus size={15} /> إضافة مصدر</>}
          </button>
        )}
      </div>

      {showForm && canManage && (
        <div className="card p-5 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm mb-1">اسم المصدر</label>
              <input className="input" value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} placeholder="مثال: صحيفة الرياض" />
            </div>
            <div>
              <label className="block text-sm mb-1">اسم مختصر (إنجليزي)</label>
              <input className="input" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm mb-1">Website URL</label>
              <div className="flex gap-2">
                <input className="input" style={{ direction: 'ltr' }} value={form.baseUrl}
                       onChange={(e) => { setForm({ ...form, baseUrl: e.target.value }); setDiscovery(null); }}
                       placeholder="https://example.com" />
                <button type="button" className="btn-ghost shrink-0" disabled={!form.baseUrl || testConnection.isPending}
                        onClick={() => testConnection.mutate(form.baseUrl)}>
                  {testConnection.isPending ? 'جارٍ الاختبار…' : 'اختبار الاتصال'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm mb-1">الدولة</label>
              <input className="input" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="السعودية" />
            </div>
            <div>
              <label className="block text-sm mb-1">اللغة</label>
              <input className="input" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="ar" />
            </div>
            <div>
              <label className="block text-sm mb-1">نوع المصدر</label>
              <select className="input" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>
                {Object.entries(SOURCE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">طريقة الجلب</label>
              <select className="input" value={form.connectorType} onChange={(e) => setForm({ ...form, connectorType: e.target.value })}>
                {Object.entries(CONNECTOR_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1">RSS URL</label>
              <input className="input" style={{ direction: 'ltr' }} value={form.rssUrl} onChange={(e) => setForm({ ...form, rssUrl: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm mb-1">Sitemap URL</label>
              <input className="input" style={{ direction: 'ltr' }} value={form.sitemapUrl} onChange={(e) => setForm({ ...form, sitemapUrl: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm mb-1">وزن المصدر (1-100)</label>
              <input type="number" min={1} max={100} className="input num" value={form.sourceWeight}
                     onChange={(e) => setForm({ ...form, sourceWeight: Number(e.target.value) })} />
            </div>
            <div>
              <label className="block text-sm mb-1">فترة الفحص (دقائق)</label>
              <input type="number" min={5} className="input num" value={form.checkIntervalMinutes}
                     onChange={(e) => setForm({ ...form, checkIntervalMinutes: Number(e.target.value) })} />
            </div>
          </div>

          {testConnection.error && (
            <div className="text-xs p-2.5 rounded-lg bg-red-500/10 text-red-600">
              {testConnection.error instanceof ApiError ? testConnection.error.message : 'تعذّر اختبار الاتصال'}
            </div>
          )}

          {discovery && <DiscoveryPanel discovery={discovery} />}

          <div className="flex justify-end gap-2 pt-1">
            {createSource.error && (
              <span className="text-xs text-red-600 self-center">
                {createSource.error instanceof ApiError ? createSource.error.message : 'تعذّر الحفظ'}
              </span>
            )}
            <button className="btn-primary" disabled={!form.nameAr || !form.baseUrl || createSource.isPending}
                    onClick={() => createSource.mutate()}>
              {createSource.isPending ? 'جارٍ الحفظ…' : 'حفظ المصدر'}
            </button>
          </div>
        </div>
      )}

      {isLoading && <div className="card p-10 text-center muted">جارٍ التحميل…</div>}
      {!isLoading && !data?.items.length && (
        <div className="card p-10 text-center">
          <div className="font-medium">لا توجد مصادر أخبار بعد</div>
          <p className="mt-1 text-sm muted">أضف أول مصدر لتبدأ منصة رصد الأخبار والمواقع.</p>
        </div>
      )}

      <div className="space-y-3">
        {(data?.items ?? []).map((s) => {
          const health = HEALTH[s.health_state] ?? HEALTH.healthy;
          return (
            <div key={s.id} className={`card p-4 ${!s.is_active ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-semibold">{s.name_ar}</span>
                    <span className="badge bg-[var(--surface-3)]">{SOURCE_TYPES[s.source_type] ?? s.source_type}</span>
                    <span className="badge bg-[var(--surface-3)]">{CONNECTOR_TYPES[s.connector_type] ?? s.connector_type}</span>
                    <span className={`badge ${health.cls}`}>{health.text}</span>
                    {!s.is_active && <span className="badge bg-slate-500/15 text-slate-500">معطّل</span>}
                  </div>
                  <a href={s.base_url} target="_blank" rel="noreferrer" className="text-xs muted hover:text-brand-600" style={{ direction: 'ltr', unicodeBidi: 'plaintext' }}>
                    {s.base_url}
                  </a>
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs muted">
                    <span>وزن المصدر: <span className="num">{s.source_weight}</span></span>
                    <span>فترة الفحص: <span className="num">{s.check_interval_minutes}</span> د</span>
                    <span>عمليات الجلب: <span className="num">{fmtNum(s.total_fetches)}</span></span>
                    <span>الأخطاء: <span className="num">{fmtNum(s.total_errors)}</span></span>
                    <span>آخر فحص: {s.last_checked_at ? fmtRelative(s.last_checked_at) : 'لم يُفحص بعد'}</span>
                  </div>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-2">
                    <button className="btn-ghost !text-xs" disabled={testingSourceId === s.id}
                            onClick={() => testExistingSource.mutate({ id: s.id })}>
                      {testingSourceId === s.id ? 'جارٍ الاختبار…' : 'اختبار الاتصال'}
                    </button>
                    <button className="btn-ghost !text-xs" disabled={toggleActive.isPending}
                            onClick={() => toggleActive.mutate({ id: s.id, isActive: !s.is_active })}>
                      {s.is_active ? 'تعطيل' : 'تفعيل'}
                    </button>
                  </div>
                )}
              </div>
              {sourceErrors[s.id] && (
                <div className="mt-3 text-xs p-2.5 rounded-lg bg-red-500/10 text-red-600">{sourceErrors[s.id]}</div>
              )}
              {sourceResults[s.id] && (
                <div className="mt-3">
                  <DiscoveryPanel discovery={sourceResults[s.id]} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
