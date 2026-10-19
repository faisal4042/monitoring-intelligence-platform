/**
 * «إعدادات بطاقات المؤثرين» — the template studio: template list, settings
 * editor and a live preview drawn by the card's own renderer (the same code as
 * the export). Drafts are saved with a revision check; publishing freezes an
 * immutable version; a published template can be made the default of its
 * program (or the global default) and disabled without being deleted.
 *
 * Read access: influencer_card_templates:read; changes: …:manage (both
 * proposed in migration 0048 and granted to no role by default). Preview data
 * is either the built-in sample or a real tracked account the user may read
 * (the card API applies influencers:read + posts:read). No influencer data is
 * ever written into a template.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Copy, Eye, FileDown, ImageDown, Plus, RotateCcw, Save, Send, Star, StarOff, ToggleLeft, ToggleRight } from 'lucide-react';
import { canManageCardTemplates, canReadInfluencerCards, BUILTIN_CARD_TEMPLATE, PERMISSIONS, cardTemplateConfigSchema, cardTemplateIssues, type CardTemplateConfig } from '@mip/shared';
import { api, ApiError } from '../../../lib/api';
import { useAuth } from '../../../lib/auth';
import { fmtDateTime, fmtNum } from '../../../lib/format';
import { cardFileName, downloadBlob, exportPdf, exportPng } from '../../../lib/influencer-cards/export';
import { SAMPLE_CARD, SAMPLE_CARD_LONG } from '../../../lib/influencer-cards/sample';
import { templatesApi, uploadCardAsset, type TemplateDetail, type TemplateSummary } from '../../../lib/influencer-cards/templates-api';
import type { CardData, CardFormat } from '../../../lib/influencer-cards/types';
import { useCardRender } from '../../../lib/influencer-cards/useCardRender';
import { useDebounced, type AccountPage } from '../../../lib/influencers';
import { CardPreview, Segmented } from '../CardExportDialog';
import { Pill } from '../shared';
import TemplateEditor, { EDITOR_TABS, type EditorTab } from './TemplateEditor';
import { Button } from '../../ui/Button';
import '../influencer-card.css';
import './studio.css';

type Tab = EditorTab | 'versions';
type Source = 'sample' | 'sample-long' | 'real';
const errText = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'تعذّر تنفيذ العملية');
/** JSON with object keys sorted: jsonb hands keys back in its own order, so plain JSON.stringify would always differ. */
const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  : JSON.stringify(v));

function StatusPills({ t }: { t: TemplateSummary }) {
  return (
    <span className="studio-badges">
      {t.status === 'disabled' && <Pill tone="muted">موقوف</Pill>}
      {t.is_default && <Pill tone="ok">{t.program_id ? 'افتراضي للبرنامج' : 'افتراضي عام'}</Pill>}
      {t.published_version ? <Pill tone="info">منشور · إصدار <span className="num">{t.published_version}</span></Pill> : <Pill tone="warn">مسودة غير منشورة</Pill>}
      {t.published_version !== null && t.has_unpublished_changes && <Pill tone="warn">تعديلات غير منشورة</Pill>}
    </span>
  );
}

function Preview({ template, label }: { template: CardTemplateConfig; label: string }) {
  const { user } = useAuth();
  const canReal = canReadInfluencerCards(user);
  const [source, setSource] = useState<Source>('sample');
  const [format, setFormat] = useState<CardFormat>('png');
  const [view, setView] = useState<'desktop' | 'mobile'>('desktop');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const [accountId, setAccountId] = useState('');
  const accounts = useQuery({
    queryKey: ['studio-accounts', query], enabled: source === 'real' && canReal,
    queryFn: ({ signal }) => api.get<AccountPage>(`/influencers/accounts?range=30d&pageSize=20&sort=total_posts${query ? `&q=${encodeURIComponent(query)}` : ''}`, signal),
  });
  const real = useQuery({
    queryKey: ['studio-card', accountId], enabled: source === 'real' && Boolean(accountId),
    queryFn: ({ signal }) => api.get<CardData>(`/influencers/${accountId}/card?range=30d&limit=5`, signal),
  });
  const data = source === 'real' ? real.data : source === 'sample-long' ? SAMPLE_CARD_LONG : SAMPLE_CARD;
  const render = useCardRender(data, template, format, source === 'real' ? {} : { avatar: null });
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const tryExport = async (kind: 'png' | 'pdf') => {
    if (!render.layout || !data) return;
    setBusy(true); setExportError(null);
    try {
      const blob = kind === 'png' ? await exportPng(render.layout, template.output.pngScale, render.images) : await exportPdf(render.layout, render.images);
      downloadBlob(blob, cardFileName(`template-preview-${data.account.username}`, kind));
    } catch (e) { setExportError(errText(e)); } finally { setBusy(false); }
  };

  return (
    <section className="studio-preview" aria-label="المعاينة المباشرة">
      <div className="card studio-preview-bar">
        <strong className="text-sm">المعاينة — {label}</strong>
        <Segmented label="مصدر بيانات المعاينة" value={source} onChange={setSource} options={[
          { key: 'sample', label: 'بيانات تجريبية' }, { key: 'sample-long', label: 'نص طويل' },
          ...(canReal ? [{ key: 'real' as const, label: 'مؤثر حقيقي' }] : []),
        ]} />
        <Segmented label="المقاس" value={format} onChange={setFormat} options={[
          { key: 'png', label: 'PNG' }, { key: 'a4-portrait', label: 'A4 عمودي' }, { key: 'a4-landscape', label: 'A4 أفقي' },
        ]} />
        <Segmented label="العرض" value={view} onChange={setView} options={[{ key: 'desktop', label: 'سطح المكتب' }, { key: 'mobile', label: 'الجوال' }]} />
        {source === 'real' && (
          <div className="flex flex-wrap items-center gap-2" style={{ width: '100%' }}>
            <input className="input" style={{ maxWidth: 220 }} placeholder="ابحث عن حساب مؤثر…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="البحث عن حساب" />
            <select className="input" style={{ maxWidth: 280 }} value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="الحساب" data-testid="studio-account">
              <option value="">اختر حساباً…</option>
              {accounts.data?.items.map((a) => <option key={a.id} value={a.id}>@{a.username} — {fmtNum(a.total_posts)} منشور</option>)}
            </select>
            <small className="muted">يُعرض ما تملك صلاحية الاطلاع عليه فقط، ولا يُحفظ شيء منه في القالب.</small>
          </div>
        )}
        <span className="ms-auto flex gap-2">
          {/* Sample data only: a real account's card is exported from the export dialog, where the export is logged. */}
          <Button variant="ghost" type="submit" disabled={!render.layout || busy || format !== 'png' || source === 'real'} onClick={() => tryExport('png')}
            title={source === 'real' ? 'صدّر بطاقات الحسابات الحقيقية من نافذة التصدير ليُسجَّل التصدير' : 'تنزيل المعاينة كصورة'}><ImageDown size={14} /> PNG</Button>
          <Button variant="ghost" type="submit" disabled={!render.layout || busy || format === 'png' || source === 'real'} onClick={() => tryExport('pdf')}
            title={source === 'real' ? 'صدّر بطاقات الحسابات الحقيقية من نافذة التصدير ليُسجَّل التصدير' : 'تنزيل المعاينة كملف PDF'}><FileDown size={14} /> PDF</Button>
        </span>
      </div>
      {render.missingImages.length > 0 && <div className="studio-banner studio-banner--warn">تعذّر تحميل {render.missingImages.join(' و')}؛ تُرسم البطاقة بدونه.</div>}
      {exportError && <div className="studio-banner studio-banner--warn" role="alert">{exportError}</div>}
      <div className="studio-preview-stage" data-view={view} aria-busy={render.loading}>
        {render.error ? <div className="inf-state inf-state--error" role="alert">{render.error}</div>
          : source === 'real' && !accountId ? <div className="inf-state">اختر حساباً لمعاينة القالب على بياناته.</div>
          : real.error && source === 'real' ? <div className="inf-state inf-state--error" role="alert">{errText(real.error)}</div>
          : render.layout ? <CardPreview layout={render.layout} images={render.images} />
          : <div className="inf-skeleton" style={{ height: 420 }} aria-label="جارٍ تجهيز المعاينة" />}
      </div>
    </section>
  );
}

function NewTemplate({ onCreated, programs }: { onCreated: (t: TemplateDetail) => void; programs: Array<{ id: string; name_ar: string }> }) {
  const [name, setName] = useState('');
  const [programId, setProgramId] = useState('');
  const create = useMutation({ retry: false, mutationFn: () => templatesApi.create({ name: name.trim(), programId: programId || null }), onSuccess: onCreated });
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
      <input className="input" placeholder="اسم القالب" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} aria-label="اسم القالب الجديد" autoFocus />
      <select className="input" value={programId} onChange={(e) => setProgramId(e.target.value)} aria-label="البرنامج">
        <option value="">عام (كل البرامج)</option>
        {programs.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
      </select>
      <Button variant="primary" type="submit" disabled={!name.trim() || create.isPending}>{create.isPending ? 'جارٍ الإنشاء…' : 'إنشاء من القالب المدمج'}</Button>
      {create.error && <small className="studio-error" role="alert">{errText(create.error)}</small>}
    </form>
  );
}

export default function CardStudio() {
  const { can, user } = useAuth();
  const canManage = canManageCardTemplates(user);
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('template');
  const select = (id: string | null) => setParams((prev) => { const p = new URLSearchParams(prev); if (id) p.set('template', id); else p.delete('template'); return p; });

  const list = useQuery({ queryKey: ['card-templates'], queryFn: ({ signal }) => templatesApi.list(signal), retry: false });
  const notActivated = list.error instanceof ApiError && list.error.code === 'CARD_TEMPLATES_NOT_ACTIVATED';
  const detail = useQuery({ queryKey: ['card-template', selectedId], enabled: Boolean(selectedId) && !notActivated, queryFn: ({ signal }) => templatesApi.get(selectedId!, signal) });
  const assets = useQuery({ queryKey: ['card-template-assets'], enabled: list.isSuccess, queryFn: ({ signal }) => templatesApi.assets(signal) });
  const programs = useQuery({
    queryKey: ['programs'], enabled: can(PERMISSIONS.PROGRAMS_READ), staleTime: 5 * 60_000,
    queryFn: () => api.get<{ items: Array<{ id: string; name_ar: string; is_active: boolean }> }>('/programs'),
  });

  const t = detail.data;
  const [draft, setDraft] = useState<CardTemplateConfig | null>(null);
  const [meta, setMeta] = useState({ name: '', description: '', programId: '' });
  const [viewing, setViewing] = useState<{ version: number; config: CardTemplateConfig } | null>(null);
  const [tab, setTab] = useState<Tab>('colors');
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // A freshly loaded revision replaces the local copy.
  useEffect(() => {
    if (!t) { setDraft(null); return; }
    const parsed = cardTemplateConfigSchema.safeParse(t.draft_config);
    setDraft(parsed.success ? parsed.data : structuredClone(BUILTIN_CARD_TEMPLATE));
    setMeta({ name: t.name, description: t.description ?? '', programId: t.program_id ?? '' });
    setViewing(null);
  }, [t?.id, t?.draft_revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = Boolean(t && draft && (canonical(draft) !== canonical(t.draft_config)
    || meta.name !== t.name || meta.description !== (t.description ?? '') || meta.programId !== (t.program_id ?? '')));
  const validation = useMemo(() => (draft ? cardTemplateConfigSchema.safeParse(draft) : null), [draft]);
  const errors = validation && !validation.success ? cardTemplateIssues(validation.error) : {};
  const valid = Boolean(validation?.success) && meta.name.trim().length > 0;
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const navigation = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest('a[href]');
      const tab = target?.closest('button[id^="inf-tab-"]');
      if (((link && (link as HTMLAnchorElement).href !== location.href) || (tab && tab.id !== 'inf-tab-cards')) && !window.confirm('لديك تعديلات غير محفوظة. هل تريد مغادرة محرر البطاقة؟')) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', navigation, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', navigation, true); };
  }, [dirty]);

  const refresh = (next?: TemplateDetail) => {
    if (next) qc.setQueryData(['card-template', next.id], next);
    qc.invalidateQueries({ queryKey: ['card-templates'] });
    qc.invalidateQueries({ queryKey: ['card-templates-published'] });
  };
  const act = useMutation({
    retry: false,
    mutationFn: async (fn: () => Promise<TemplateDetail>) => fn(),
    onMutate: () => { setActionError(null); setActionSuccess(null); },
    onSuccess: (next) => { refresh(next); setActionSuccess('تم تأكيد العملية من الخادم.'); if (next.id !== selectedId) select(next.id); },
    onError: (e) => setActionError(errText(e)),
  });
  const leaveGuard = () => !dirty || window.confirm('لديك تعديلات غير محفوظة في هذا القالب. هل تريد تجاهلها؟');

  const save = () => t && draft && act.mutate(() => templatesApi.update(t.id, {
    revision: t.draft_revision, config: draft, name: meta.name.trim(), description: meta.description.trim() || null, programId: meta.programId || null,
  }));
  const publish = () => t && act.mutate(() => templatesApi.publish(t.id, t.draft_revision, note.trim() || undefined).then((r) => { setNote(''); return r; }));
  const items = list.data?.items ?? [];
  const editing = canManage && !viewing && !notActivated && !act.isPending;
  // A version being viewed, else the valid draft, else (nothing selected) the built-in card.
  const previewConfig = viewing?.config ?? (t && draft ? (validation?.success ? validation.data : null) : BUILTIN_CARD_TEMPLATE);

  return (
    <div className="space-y-3" role="tabpanel" id="inf-panel-cards" aria-labelledby="inf-tab-cards">
      {notActivated && (
        <div className="studio-banner studio-banner--warn" role="status" data-testid="studio-not-activated">
          قوالب البطاقات غير مفعّلة بعد: تتطلب اعتماد Migration 0048 وتطبيقها. يُستخدم حالياً القالب المدمج في التصدير، والمعروض أدناه معاينته للقراءة فقط.
        </div>
      )}
      <div className="studio">
        <aside className="card studio-list" aria-label="قائمة القوالب">
          <div className="studio-list-head">
            <strong>القوالب</strong>
            {canManage && !notActivated && <Button variant="ghost" type="submit" onClick={() => leaveGuard() && setCreating((v) => !v)}><Plus size={14} /> قالب جديد</Button>}
          </div>
          {creating && <NewTemplate programs={programs.data?.items ?? []} onCreated={(n) => { setCreating(false); refresh(n); select(n.id); }} />}
          {list.isLoading && <div className="inf-skeleton" style={{ height: 120 }} />}
          {list.error && !notActivated && <div className="inf-state inf-state--error" role="alert">{errText(list.error)}</div>}
          {list.isSuccess && items.length === 0 && <p className="text-xs muted">لا توجد قوالب بعد. يُستخدم القالب المدمج في التصدير.</p>}
          {items.map((it) => (
            <button key={it.id} type="button" className="studio-item" aria-current={it.id === selectedId} onClick={() => leaveGuard() && select(it.id)}>
              <strong>{it.name}</strong>
              <small className="muted">{it.program_name ?? 'عام — كل البرامج'}</small>
              <StatusPills t={it} />
            </button>
          ))}
        </aside>

        <section className="card studio-editor" aria-label="محرر القالب">
          {!t || !draft ? (
            <div className="studio-panel">
              {notActivated ? <p className="text-sm muted">المحرر متاح بعد تفعيل القوالب.</p>
                : detail.isLoading ? <div className="inf-skeleton" style={{ height: 300 }} />
                : <p className="text-sm muted">اختر قالباً من القائمة{canManage ? ' أو أنشئ قالباً جديداً' : ''}.</p>}
            </div>
          ) : (
            <>
              <div className="studio-editor-head">
                <div className="flex flex-wrap items-center gap-2">
                  <input className="input" style={{ flex: '1 1 160px', fontWeight: 400 }} value={meta.name} maxLength={120} disabled={!editing}
                    onChange={(e) => setMeta({ ...meta, name: e.target.value })} aria-label="اسم القالب" />
                  <select className="input" style={{ flex: '1 1 140px' }} value={meta.programId} disabled={!editing || t.is_default}
                    onChange={(e) => setMeta({ ...meta, programId: e.target.value })} aria-label="البرنامج المرتبط"
                    title={t.is_default ? 'ألغِ التعيين الافتراضي لتغيير البرنامج' : undefined}>
                    <option value="">عام — كل البرامج</option>
                    {(programs.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
                    {t.program_id && !programs.data?.items.some((p) => p.id === t.program_id) && <option value={t.program_id}>{t.program_name ?? 'برنامج'}</option>}
                  </select>
                </div>
                <StatusPills t={t} />
                <small className="muted">مراجعة المسودة <span className="num">{t.draft_revision}</span> · آخر تعديل {fmtDateTime(t.updated_at)}{t.updated_by_name ? ` — ${t.updated_by_name}` : ''}</small>
                {viewing && (
                  <div className="studio-banner" data-testid="studio-viewing-version">
                    تعرض الإصدار المنشور <span className="num">{viewing.version}</span> للقراءة فقط.{' '}
                    <Button variant="ghost" type="submit" onClick={() => setViewing(null)}>العودة إلى المسودة</Button>
                  </div>
                )}
              </div>
              <div className="studio-tabs" role="tablist" aria-label="أقسام إعدادات القالب">
                {[...EDITOR_TABS, { key: 'versions' as const, label: `الإصدارات (${t.versions.length})` }].map((x) => (
                  <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} onClick={() => setTab(x.key)}>{x.label}</button>
                ))}
              </div>
              <div className="studio-panel" role="tabpanel">
                {tab === 'versions' ? (
                  <div className="studio-versions">
                    {t.versions.length === 0 && <p className="text-sm muted">لم يُنشر أي إصدار بعد. النشر يجمّد نسخة من المسودة لا تتغير بعد ذلك.</p>}
                    {t.versions.map((v) => (
                      <div key={v.version} className="studio-version" data-testid={`version-${v.version}`}>
                        <strong>الإصدار <span className="num">{v.version}</span></strong>
                        {v.version === t.published_version && <Pill tone="info">الحالي</Pill>}
                        <span className="muted">{fmtDateTime(v.published_at)}{v.published_by_name ? ` — ${v.published_by_name}` : ''}</span>
                        {v.note && <span>«{v.note}»</span>}
                        <span className="ms-auto flex gap-1">
                          <Button variant="ghost" type="submit" onClick={async () => { const full = await templatesApi.version(t.id, v.version); setViewing({ version: v.version, config: full.config }); }}><Eye size={14} /> معاينة</Button>
                          {canManage && <Button variant="ghost" type="submit" disabled={act.isPending} onClick={() => leaveGuard() && act.mutate(() => templatesApi.restore(t.id, t.draft_revision, v.version))}>
                            <RotateCcw size={14} /> استعادة إلى المسودة</Button>}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <TemplateEditor tab={tab} config={viewing?.config ?? draft} onChange={setDraft} errors={viewing ? {} : errors} disabled={!editing}
                    assets={assets.data?.items ?? []}
                    onUpload={async (file, kind) => { const a = await uploadCardAsset(file, kind); await qc.invalidateQueries({ queryKey: ['card-template-assets'] }); return a.id; }} />
                )}
              </div>
              {canManage && (
                <div className="studio-actions">
                  <span role="status" data-testid="studio-dirty">{dirty ? 'تعديلات غير محفوظة' : 'المسودة مطابقة لآخر حفظ مؤكد'}</span>
                  <Button variant="ghost" type="submit" onClick={() => document.querySelector('.studio-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><Eye size={14} /> معاينة</Button>
                  <Button variant="primary" type="submit" data-testid="studio-save" disabled={!dirty || !valid || act.isPending} onClick={save}><Save size={14} /> حفظ المسودة</Button>
                  <Button variant="ghost" type="submit" data-testid="studio-reset" disabled={!dirty || act.isPending}
                    onClick={() => { setDraft(cardTemplateConfigSchema.parse(t.draft_config)); setMeta({ name: t.name, description: t.description ?? '', programId: t.program_id ?? '' }); }}>
                    <RotateCcw size={14} /> تجاهل التعديلات</Button>
                  <input className="input" style={{ flex: '1 1 140px' }} placeholder="ملاحظة الإصدار (اختياري)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} aria-label="ملاحظة الإصدار" />
                  <Button variant="primary" type="submit" data-testid="studio-publish" disabled={dirty || act.isPending || !valid || (t.published_version !== null && !t.has_unpublished_changes)}
                    title={dirty ? 'احفظ المسودة أولاً' : undefined} onClick={publish}><Send size={14} /> نشر</Button>
                  <Button variant="ghost" type="submit" data-testid="studio-duplicate" disabled={act.isPending} onClick={() => leaveGuard() && act.mutate(() => templatesApi.duplicate(t.id))}><Copy size={14} /> استنساخ</Button>
                  <Button variant="ghost" type="submit" data-testid="studio-default" disabled={act.isPending || (!t.is_default && (t.status !== 'active' || !t.published_version))}
                    onClick={() => act.mutate(() => templatesApi.setDefault(t.id, !t.is_default))}>
                    {t.is_default ? <><StarOff size={14} /> إلغاء الافتراضي</> : <><Star size={14} /> تعيين افتراضياً{t.program_name ? ` لـ${t.program_name}` : ' عاماً'}</>}</Button>
                  <Button variant="ghost" type="submit" data-testid="studio-status" disabled={act.isPending} onClick={() => act.mutate(() => templatesApi.setStatus(t.id, t.status === 'active' ? 'disabled' : 'active'))}>
                    {t.status === 'active' ? <><ToggleLeft size={14} /> إيقاف</> : <><ToggleRight size={14} /> تفعيل</>}</Button>
                  {actionError && <small className="studio-error" role="alert" style={{ width: '100%' }}>{actionError}</small>}
                  {actionSuccess && <small role="status" style={{ width: '100%' }}>{actionSuccess}</small>}
                  {!valid && <small className="studio-error" style={{ width: '100%' }}>صحّح الحقول المعلّمة قبل الحفظ.</small>}
                </div>
              )}
            </>
          )}
        </section>

        {previewConfig
          ? <Preview template={previewConfig} label={viewing ? `الإصدار ${viewing.version}` : t ? (dirty ? 'المسودة (غير محفوظة)' : 'المسودة') : 'القالب المدمج'} />
          : <section className="card studio-preview-bar"><span className="text-sm muted">لا تُعرض معاينة لقيم غير صالحة؛ صحّح الحقول المعلّمة.</span></section>}
      </div>
    </div>
  );
}
