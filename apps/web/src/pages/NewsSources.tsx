import { useConfirmAction } from '../components/ConfirmAction';
import { FormField, FieldInput, FieldSelect, FieldTextarea } from '../components/FormField';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PERMISSIONS } from '@mip/shared';
import { Plus, Rss, X } from 'lucide-react';
import SourceManager from '../components/news/SourceManager';
import CollectionMonitor from '../components/news/CollectionMonitor';
import type { ManagedSource } from '../components/news/source-management-model';

import { Button } from '../components/ui/Button';
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
  extraction_mode: 'off' | 'shadow' | 'static' | 'dynamic';
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
// Article-text extraction per source (Scrapling engine). Takes effect only when the engine is enabled globally.
const EXTRACTION_MODES: Record<NewsSource['extraction_mode'], { text: string; hint: string }> = {
  off: { text: 'بدون استخراج', hint: 'الخلاصة وخريطة الموقع فقط، كما هو الحال اليوم' },
  shadow: { text: 'ظل (قياس فقط)', hint: 'يُستخرج النص للمقارنة دون أي تغيير على الأخبار المحفوظة' },
  static: { text: 'استخراج ثابت', hint: 'جلب صفحة المقال واستخراج النص دون متصفح' },
  dynamic: { text: 'ثابت + متصفح عند الحاجة', hint: 'يُستخدم المتصفح فقط إذا خلت الصفحة من النص ويتطلب تفعيله عالميًا' },
};

function DiscoveryPanel({ discovery }: { discovery: DiscoveryResult }) {
  return (
    <div className="rounded-xl border p-4 space-y-2" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}>
      <div className="text-sm font-medium mb-1">نتيجة اختبار الاتصال</div>
      <div className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <div>الاتصال: <b className={discovery.connectionOk ? 'text-(--status-success)' : 'text-(--status-danger)'}>{discovery.connectionOk ? 'ناجح' : 'فشل'}</b></div>
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
        <ul className="text-xs text-(--status-warning) list-disc list-inside">
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
  const confirmation = useConfirmAction();
  const canManage = can(PERMISSIONS.NEWS_MANAGE_SOURCES);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [lastTest, setLastTest] = useState<Record<string, number>>({});
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);

  const testConnection = useMutation({
    mutationFn: (url: string) => api.post<DiscoveryResult>('/news/sources/test-connection', { url }),
    onMutate: (url) => setLastTest(p => ({ ...p, [url]: Date.now() })),
    onSuccess: setDiscovery,
  });

  const [sourceResults, setSourceResults] = useState<Record<string, DiscoveryResult>>({});
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [testingSourceId, setTestingSourceId] = useState<string | null>(null);
  const testExistingSource = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      setLastTest(p => ({ ...p, [id]: Date.now() }));
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
    mutationFn: () => {
      const payload = {
      ...form,
      nameEn: form.nameEn || undefined,
      country: form.country || undefined,
      rssUrl: form.rssUrl || undefined,
      sitemapUrl: form.sitemapUrl || undefined,
      apiUrl: form.apiUrl || undefined,
      };
      if (editingId) { const { baseUrl: _url, ...patch } = payload; return api.patch(`/news/sources/${editingId}`, patch); }
      return api.post('/news/sources', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['news-sources'] });
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      setDiscovery(null);
    },
  });

  const [modeError, setModeError] = useState<Record<string, string>>({});
  const setExtractionMode = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: NewsSource['extraction_mode'] }) => api.patch(`/news/sources/${id}`, { extractionMode: mode }),
    onSuccess: (_d, { id }) => { setModeError((p) => ({ ...p, [id]: '' })); qc.invalidateQueries({ queryKey: ['news-sources'] }); qc.invalidateQueries({ queryKey: ['news-extraction-metrics'] }); },
    onError: (err: unknown, { id }) => setModeError((p) => ({ ...p, [id]: err instanceof ApiError ? err.message : 'تعذّر حفظ وضع الاستخراج' })),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      isActive ? api.patch(`/news/sources/${id}`, { isActive: true }) : api.del(`/news/sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['news-sources'] }),
  });

  return (
    <div className="space-y-5">
      {confirmation.dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><Rss size={22} className="text-brand-600" /> مصادر الأخبار</h1>
          <p className="text-sm muted">جلب دوري من الخلاصات وخرائط المواقع، مع مراقبة صحة الجمع واستخراج نص المقالات للمصادر المفعّلة</p>
        </div>
        {canManage && (
          <Button variant="primary" type="submit" onClick={() => { setEditingId(null); setForm(emptyForm); setDiscovery(null); setShowForm((v) => !v); }}>
            {showForm ? <><X size={15} /> إلغاء</> : <><Plus size={15} /> إضافة مصدر</>}
          </Button>
        )}
      </div>

      {showForm && canManage && (
        <div className="card p-5 space-y-4" id="source-edit-form">
          <h2 className="font-semibold">{editingId ? 'تعديل المصدر' : 'إضافة مصدر'}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FormField label={<>اسم المصدر</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} placeholder="مثال: صحيفة الرياض" />
              </FormField>
            </div>
            <div>
              <FormField label={<>اسم مختصر (إنجليزي)</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
              </FormField>
            </div>
            <div className="sm:col-span-2">
              <FormField label="رابط الموقع" disabled={!!editingId}>
              <div className="flex gap-2">
                <FieldInput className="input" style={{ direction: 'ltr' }} value={form.baseUrl} disabled={!!editingId}
                       onChange={(e) => { setForm({ ...form, baseUrl: e.target.value }); setDiscovery(null); }}
                       placeholder="https://example.com" />
                <Button variant="ghost" type="button" className="shrink-0" disabled={!form.baseUrl || testConnection.isPending || Date.now()-(lastTest[form.baseUrl] ?? 0)<60_000}
                        onClick={() => testConnection.mutate(form.baseUrl)}>
                  {testConnection.isPending ? 'جارٍ الاختبار…' : 'اختبار الاتصال'}
                </Button>
              </div></FormField>
            </div>
            <div>
              <FormField label={<>الدولة</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="السعودية" />
              </FormField>
            </div>
            <div>
              <FormField label={<>اللغة</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="ar" />
              </FormField>
            </div>
            <div>
              <FormField label={<>نوع المصدر</>} labelClassName="block text-sm mb-1">
                <FieldSelect className="input" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value })}>
                {Object.entries(SOURCE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </FieldSelect>
              </FormField>
            </div>
            <div>
              <FormField label={<>طريقة الجلب</>} labelClassName="block text-sm mb-1">
                <FieldSelect className="input" value={form.connectorType} onChange={(e) => setForm({ ...form, connectorType: e.target.value })}>
                {Object.entries(CONNECTOR_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </FieldSelect>
              </FormField>
            </div>
            <div>
              <FormField label={<>RSS URL</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" style={{ direction: 'ltr' }} value={form.rssUrl} onChange={(e) => setForm({ ...form, rssUrl: e.target.value })} />
              </FormField>
            </div>
            <div>
              <FormField label={<>Sitemap URL</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" style={{ direction: 'ltr' }} value={form.sitemapUrl} onChange={(e) => setForm({ ...form, sitemapUrl: e.target.value })} />
              </FormField>
            </div>
            <div className="sm:col-span-2">
              <FormField label={<>API URL</>} labelClassName="block text-sm mb-1">
                <FieldInput className="input" style={{ direction: 'ltr' }} value={form.apiUrl} onChange={(e) => setForm({ ...form, apiUrl: e.target.value })} />
              </FormField>
            </div>
            <div>
              <FormField label={<>وزن المصدر (1-100)</>} labelClassName="block text-sm mb-1">
                <FieldInput type="number" min={1} max={100} className="input num" value={form.sourceWeight}
                     onChange={(e) => setForm({ ...form, sourceWeight: Number(e.target.value) })} />
              </FormField>
            </div>
            <div>
              <FormField label={<>فترة الفحص (دقائق)</>} labelClassName="block text-sm mb-1">
                <FieldInput type="number" min={5} className="input num" value={form.checkIntervalMinutes}
                     onChange={(e) => setForm({ ...form, checkIntervalMinutes: Number(e.target.value) })} />
              </FormField>
            </div>
          </div>

          {testConnection.error && (
            <div className="text-xs p-2.5 rounded-lg bg-(--status-danger-soft) text-(--status-danger)">
              {testConnection.error instanceof ApiError ? testConnection.error.message : 'تعذّر اختبار الاتصال'}
            </div>
          )}

          {discovery && <DiscoveryPanel discovery={discovery} />}

          <div className="flex justify-end gap-2 pt-1">
            {createSource.error && (
              <span className="text-xs text-(--status-danger) self-center">
                {createSource.error instanceof ApiError ? createSource.error.message : 'تعذّر الحفظ'}
              </span>
            )}
            <Button variant="primary" type="submit" disabled={!form.nameAr || !form.baseUrl || createSource.isPending}
                    onClick={() => createSource.mutate()}>
              {createSource.isPending ? 'جارٍ الحفظ…' : 'حفظ المصدر'}
            </Button>
          </div>
        </div>
      )}

      <SourceManager actions={canManage ? (s: ManagedSource) => <div className="space-y-3">
        <p className="text-xs muted">اختبار الاتصال يدوي ومحدود؛ قد يسجل نتيجة الفحص ويكتشف روابط. لا يُشغّل تلقائيًا عند فتح التفاصيل.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" type="submit" className="!text-xs" onClick={() => {
            setEditingId(s.id); setForm({ nameAr:s.name_ar,nameEn:s.name_en ?? '',baseUrl:s.base_url,country:s.country ?? '',language:s.language,
              sourceType:s.source_type,connectorType:s.connector_type,rssUrl:s.rss_url ?? '',sitemapUrl:s.sitemap_url ?? '',apiUrl:s.api_url ?? '',sourceWeight:s.source_weight,checkIntervalMinutes:s.check_interval_minutes });
            setDiscovery(null); setShowForm(true);
          }}>تعديل المصدر</Button>
          <Button variant="ghost" type="submit" className="!text-xs" disabled={testExistingSource.isPending || Date.now()-(lastTest[s.id] ?? 0)<60_000}
            onClick={() => testExistingSource.mutate({id:s.id})}>{testingSourceId===s.id ? 'جارٍ الاختبار…' : 'اختبار الاتصال'}</Button>
          <Button variant="ghost" type="submit" className="!text-xs" disabled={toggleActive.isPending} onClick={()=>confirmation.request({title:s.is_active?'تعطيل مصدر الأخبار':'تفعيل مصدر الأخبار',description:`سيتم ${s.is_active?'إيقاف':'استئناف'} جمع الأخبار من «${s.name_ar}».`,confirmLabel:s.is_active?'تعطيل المصدر':'تفعيل المصدر',danger:s.is_active,allowed:can=>can(PERMISSIONS.NEWS_MANAGE_SOURCES),execute:()=>toggleActive.mutateAsync({id:s.id,isActive:!s.is_active})})}>{s.is_active?'تعطيل':'تفعيل'}</Button>
        </div>
        <label className="text-xs block">استخراج النص<select aria-label={`وضع استخراج النص لمصدر ${s.name_ar}`} className="input mt-1" value={s.extraction_mode ?? 'off'} disabled={setExtractionMode.isPending}
          onChange={e=>{const mode=e.target.value as NewsSource['extraction_mode'];confirmation.request({title:'تغيير طريقة استخراج الأخبار',description:`تغيير طريقة الاستخراج لـ«${s.name_ar}» إلى ${EXTRACTION_MODES[mode].text} يؤثر على طلبات المصدر واستهلاك الموارد.`,confirmLabel:'تغيير طريقة الاستخراج',allowed:can=>can(PERMISSIONS.NEWS_MANAGE_SOURCES),execute:()=>setExtractionMode.mutateAsync({id:s.id,mode})});}}>{Object.entries(EXTRACTION_MODES).map(([k,v])=><option key={k} value={k}>{v.text}</option>)}</select></label>
        {modeError[s.id]&&<p role="alert" className="text-xs text-(--status-danger)">{modeError[s.id]}</p>}
        {sourceErrors[s.id]&&<p role="alert" className="text-xs text-(--status-danger)">{sourceErrors[s.id]}</p>}
        {toggleActive.error&&<p role="alert" className="text-xs text-(--status-danger)">تعذر تغيير حالة المصدر.</p>}
        {sourceResults[s.id]&&<DiscoveryPanel discovery={sourceResults[s.id]}/>}
        {editingId===s.id&&showForm&&<p className="text-xs text-brand-600">نموذج التعديل جاهز أعلى الصفحة؛ أغلق التفاصيل لإكمال التعديل.</p>}
      </div> : undefined} />
      <details className="card p-4" onToggle={event => setMonitorOpen(event.currentTarget.open)}><summary className="cursor-pointer font-semibold">مؤشرات المراقبة التفصيلية</summary>{monitorOpen && <div className="mt-4"><CollectionMonitor /></div>}</details>
    </div>
  );
}
