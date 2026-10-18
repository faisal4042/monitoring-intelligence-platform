/**
 * «تصدير بطاقة المؤثر» — preview and export of one tracked account's card.
 * Data comes from GET /influencers/:id/card (stored platform data, never X).
 * The template is the published version resolved for the card's program
 * (program default → global default → built-in card), or one the user picks
 * from the published templates. Preview, PNG and PDF are painted by the same
 * renderer from the same layout (lib/influencer-cards). Nothing here writes.
 * Offered from the influencer hub's accounts table only.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileDown, IdCard, ImageDown, X } from 'lucide-react';
import { canReadInfluencerCards } from '@mip/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { fmtNum } from '../../lib/format';
import { useLocalDateRange } from '../../lib/useDateRange';
import DateRangeFilter from '../DateRangeFilter';
import type { CardImages } from '../../lib/influencer-cards/assets';
import { cardFileName, downloadBlob, exportPdf, exportPng, maxScale } from '../../lib/influencer-cards/export';
import { renderPage } from '../../lib/influencer-cards/paint';
import { templatesApi } from '../../lib/influencer-cards/templates-api';
import { exportLogApi, isTemplateChanged, periodFields, runLoggedExport } from '../../lib/influencer-cards/export-log';
import type { CardData, CardFormat, CardLayout, CardScope } from '../../lib/influencer-cards/types';
import { useCardRender } from '../../lib/influencer-cards/useCardRender';
import './influencer-card.css';

const LIMITS = [3, 5, 10, 20, 50];
const FORMATS: Array<{ key: CardFormat; label: string }> = [
  { key: 'png', label: 'صورة PNG' },
  { key: 'a4-portrait', label: 'PDF ‏A4 عمودي' },
  { key: 'a4-landscape', label: 'PDF ‏A4 أفقي' },
];
const PNG_SCALES = [2, 3];

/** Icon button for one account row; shown only to users who may read interaction data (posts:read). */
export function CardExportButton({ account }: { account: { id: string; username: string } }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!canReadInfluencerCards(user)) return null;
  return (
    <>
      <button className="icon-button" title="تصدير بطاقة المؤثر" aria-label={`تصدير بطاقة ${account.username}`} onClick={() => setOpen(true)}>
        <IdCard size={15} />
      </button>
      {open && <CardExportDialog account={account} onClose={() => setOpen(false)} />}
    </>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: Array<{ key: T; label: string }>; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="card-export-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.key)} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Paints every page of the layout with the export renderer; what is shown is what is saved. */
export function CardPreview({ layout, images, maxPreviewScale = 2 }: { layout: CardLayout; images: CardImages; maxPreviewScale?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const scale = Math.min(maxPreviewScale, maxScale(layout) || 1);
    el.replaceChildren(...layout.pages.map((page, i) => {
      const fig = document.createElement('figure');
      fig.className = 'card-export-page';
      fig.style.maxWidth = `${page.width}px`;
      const canvas = renderPage(page, scale, images);
      canvas.dataset.cardPage = String(i + 1);
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `معاينة الصفحة ${i + 1} من ${layout.pages.length}`);
      fig.append(canvas);
      if (layout.pages.length > 1) {
        const cap = document.createElement('figcaption');
        cap.textContent = `صفحة ${i + 1} من ${layout.pages.length}`;
        fig.append(cap);
      }
      return fig;
    }));
  }, [layout, images, maxPreviewScale]);
  return <div ref={host} className="card-export-pages" data-testid="card-preview" />;
}

export default function CardExportDialog({ account, onClose }: { account: { id: string; username: string }; onClose: () => void }) {
  const date = useLocalDateRange();
  const [limit, setLimit] = useState(5);
  const [scope, setScope] = useState<CardScope>('all');
  const [format, setFormat] = useState<CardFormat>('png');
  const [pngScale, setPngScale] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const card = useQuery({
    queryKey: ['influencer-card', account.id, date.apiQuery, limit, scope],
    enabled: Boolean(date.apiQuery),
    queryFn: ({ signal }) => api.get<CardData>(`/influencers/${account.id}/card?${date.apiQuery}&limit=${limit}&scope=${scope}`, signal),
  });
  const d = card.data;
  // The program a template is resolved for: the period's filter if any, else the program the account's posts link to most.
  const program = d?.programFilter?.key ?? d?.program?.key ?? null;
  const published = useQuery({ queryKey: ['card-templates-published'], queryFn: ({ signal }) => templatesApi.published(signal), staleTime: 60_000 });
  const resolved = useQuery({
    queryKey: ['card-template-resolve', program, templateId],
    enabled: card.isSuccess,
    queryFn: ({ signal }) => templatesApi.resolve({ program, templateId: templateId || null }, signal),
  });
  const template = resolved.data?.config;
  const render = useCardRender(d, template, format);
  const layout = render.layout;
  const scale = pngScale ?? template?.output.pngScale ?? 2;
  const pngLimit = layout && format === 'png' ? maxScale(layout) : 0;

  const policy = useQuery({ queryKey: ['card-export-policy'], queryFn: ({ signal }) => exportLogApi.policy(signal), staleTime: 60_000, retry: false });
  const [logNote, setLogNote] = useState<string | null>(null);

  const run = async () => {
    if (!layout || !d || !resolved.data) return;
    setBusy(true); setExportError(null); setLogNote(null);
    const r = resolved.data;
    try {
      const name = cardFileName(d.account.username, format === 'png' ? 'png' : 'pdf');
      const result = await runLoggedExport({
        policy: policy.data, pages: layout.pages.length,
        request: {
          influencerId: account.id, format, ...(format === 'png' ? { pngScale: scale as 2 | 3 } : {}), ...periodFields(date.apiQuery),
          scope, limit, ...(templateId ? { templateId } : {}),
          expected: r.source === 'template' ? { source: 'template', templateId: r.template.id, version: r.template.version } : { source: 'builtin' },
        },
        make: () => (format === 'png' ? exportPng(layout, scale, render.images) : exportPdf(layout, render.images)),
        deliver: (blob) => downloadBlob(blob, name),
      });
      if (result.logged) setLogNote(`سُجّل التصدير: وُلّد الملف${result.handedToBrowser ? ' وسُلّم للمتصفح' : ''}. لا يستطيع النظام التأكد من حفظه على جهازك.`);
    } catch (e) {
      if (isTemplateChanged(e)) { await resolved.refetch(); setExportError('تغيّر القالب المنشور منذ المعاينة؛ حُدّثت المعاينة، راجعها ثم صدّر مجدداً.'); }
      else setExportError((e as Error).message || 'تعذّر التصدير');
    } finally {
      setBusy(false);
    }
  };

  const error = date.error ?? render.error ?? (card.error as Error | null)?.message ?? (resolved.error as Error | null)?.message ?? null;
  const r = resolved.data;

  return (
    <ModalSurface label={`تصدير بطاقة @${account.username}`} onClose={onClose} busy={busy} as="div"
      panelClassName="card modal-card card-export-panel">
        <div className="card-export-head">
          <h3 className="font-bold flex items-center gap-2"><IdCard size={18} aria-hidden="true" /> تصدير بطاقة المؤثر — <span className="num">@{account.username}</span></h3>
          <ModalCloseButton className="icon-button" aria-label="إغلاق" onClick={onClose} data-dialog-initial-focus><X size={16} /></ModalCloseButton>
        </div>

        <div className="card-export-body">
          <div className="card-export-controls">
            <div className="card-export-field"><span>نطاق الرصد</span><DateRangeFilter state={date} /></div>
            <div className="card-export-field">
              <span>التفاعلات المعروضة</span>
              <Segmented label="نوع التفاعلات المعروضة" value={scope} onChange={setScope}
                options={[{ key: 'all', label: 'جميع المرصودة' }, { key: 'relevant', label: 'ذات الصلة فقط' }]} />
            </div>
            <div className="card-export-field">
              <span>عدد التفاعلات المعروضة</span>
              <Segmented label="عدد التفاعلات المعروضة" value={limit} onChange={setLimit} options={LIMITS.map((n) => ({ key: n, label: String(n) }))} />
            </div>
            <label className="card-export-field">
              <span>القالب</span>
              <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} data-testid="card-template-select"
                disabled={!published.data?.activated}>
                <option value="">تلقائي حسب البرنامج</option>
                {published.data?.items.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}{t.program_name ? ` — ${t.program_name}` : ' — عام'}{t.is_default ? ' (افتراضي)' : ''}</option>
                ))}
              </select>
              <small className="muted" data-testid="card-template-used">
                {!r ? '…' : r.source === 'template' ? `المستخدم: ${r.template.name} — الإصدار ${r.template.version}` : r.activated ? 'المستخدم: القالب المدمج (لا يوجد قالب افتراضي منشور)' : 'المستخدم: القالب المدمج'}
              </small>
            </label>
            <div className="card-export-field">
              <span>صيغة الملف</span>
              <Segmented label="صيغة الملف" value={format} onChange={setFormat} options={FORMATS} />
            </div>
            {format === 'png' && (
              <div className="card-export-field">
                <span>دقة الصورة</span>
                <Segmented label="دقة الصورة" value={scale} onChange={setPngScale} options={PNG_SCALES.map((s) => ({ key: s, label: `${s}×` }))} />
              </div>
            )}

            {d && (
              <dl className="card-export-summary" aria-label="ملخص البطاقة" data-testid="card-summary">
                <div><dt>إجمالي المنشورات المرصودة</dt><dd className="num">{fmtNum(d.figures.posts)}</dd></div>
                <div><dt>منها ذات صلة</dt><dd className="num">{fmtNum(d.figures.relevant)}</dd></div>
                <div><dt>المعروض في البطاقة</dt><dd><span className="num">{fmtNum(d.recent.length)}</span> من <span className="num">{fmtNum(d.recentAvailable)}</span></dd></div>
                <div><dt>عدد الصفحات</dt><dd className="num">{layout ? fmtNum(layout.pages.length) : '—'}</dd></div>
              </dl>
            )}
            {render.missingImages.length > 0 && <p className="text-xs text-amber-700" role="status">تعذّر تحميل {render.missingImages.join(' و')}؛ تُرسم البطاقة بدونه.</p>}
            <p className="text-xs muted">تُبنى البطاقة من البيانات المخزّنة في المنصة فقط، دون أي استدعاء لـ X. ما تراه في المعاينة هو ما يُحفظ في الملف.</p>
          </div>

          <div className="card-export-preview" aria-busy={card.isFetching || render.loading || resolved.isFetching}>
            {error ? <div className="inf-state inf-state--error" role="alert">{error}</div>
              : !layout ? <div className="inf-skeleton" style={{ height: 480 }} aria-label="جارٍ تجهيز المعاينة" />
              : <CardPreview layout={layout} images={render.images} />}
          </div>
        </div>

        <div className="card-export-foot">
          {format === 'png' && layout && pngLimit < scale && (
            <span className="text-xs text-amber-700" role="status">البطاقة طويلة على صورة واحدة بهذه الدقة — قلّل الدقة أو عدد التفاعلات، أو اختر PDF.</span>
          )}
          {exportError && <span className="text-xs text-red-600" role="alert">{exportError}</span>}
          {logNote && <span className="text-xs muted" role="status" data-testid="card-export-log">{logNote}</span>}
          {policy.data && !policy.data.allowed && <span className="text-xs text-amber-700" role="status">التصدير يتطلب صلاحية {policy.data.permission}.</span>}
          <span className="ms-auto" />
          <ModalCloseButton className="btn-ghost" onClick={onClose}>إغلاق</ModalCloseButton>
          <button className="btn-primary" data-testid="card-export-run" disabled={!layout || busy || !resolved.data || !policy.data || !policy.data.allowed || (format === 'png' && pngLimit < scale)} onClick={run}>
            {format === 'png' ? <ImageDown size={15} /> : <FileDown size={15} />}
            {busy ? 'جارٍ التصدير…' : format === 'png' ? 'تحميل PNG' : 'تحميل PDF'}
          </button>
        </div>
    </ModalSurface>
  );
}
