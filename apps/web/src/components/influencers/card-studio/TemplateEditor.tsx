/**
 * The template settings, grouped by tab. Pure form: it edits a configuration
 * object and reports it up; validation messages come from the shared schema.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { loadCardAsset } from '../../../lib/influencer-cards/assets';
import { ArrowDown, ArrowUp, Upload } from 'lucide-react';
import {
  CARD_ARABIC_FONTS, CARD_FONT_LABELS, CARD_LATIN_FONTS, CARD_STAT_LABELS, CARD_SECTION_LABELS, CARD_STYLES, CARD_STYLE_LABELS, resolveCardDesign, type CardTemplateConfig,
} from '@mip/shared';
import type { CardAsset } from '../../../lib/influencer-cards/templates-api';
import { ColorField, RangeField, SelectField, TextField, ToggleField } from './fields';
import { validateCardAssetFile } from '../../../lib/influencer-cards/upload-policy';

export type EditorTab = 'colors' | 'fonts' | 'brand' | 'layout' | 'content' | 'text' | 'output';
export const EDITOR_TABS: Array<{ key: EditorTab; label: string }> = [
  { key: 'colors', label: 'الألوان' }, { key: 'fonts', label: 'الخطوط' }, { key: 'brand', label: 'الشعار والخلفية' },
  { key: 'layout', label: 'التخطيط' }, { key: 'content', label: 'المحتوى' }, { key: 'text', label: 'النصوص' }, { key: 'output', label: 'المخرجات' },
];

type C = CardTemplateConfig;
const COLOR_GROUPS: Array<{ title: string; keys: Array<[keyof C['colors'], string]> }> = [
  { title: 'الصفحة والبطاقات', keys: [['page', 'خلفية الصفحة'], ['surface', 'البطاقات الداخلية'], ['border', 'الحدود']] },
  { title: 'الترويسة', keys: [['header', 'خلفية الترويسة'], ['headerText', 'نص الترويسة'], ['headerMuted', 'النص الثانوي'], ['accent', 'خط التمييز والزخارف']] },
  { title: 'النصوص', keys: [['title', 'العناوين'], ['text', 'نص التفاعلات'], ['muted', 'النص الثانوي'], ['link', 'الروابط']] },
  { title: 'التذييل', keys: [['footer', 'خلفية التذييل'], ['footerText', 'نص التذييل']] },
  { title: 'المؤشرات والمشاعر', keys: [['indicator', 'مؤشر «ذات صلة»'], ['positive', 'إيجابي'], ['neutral', 'محايد'], ['negative', 'سلبي'], ['unclassified', 'غير مصنف']] },
];
const VISIBILITY: Array<{ title: string; keys: Array<[keyof C['visibility'], string]> }> = [
  { title: 'الترويسة', keys: [['issueDate', 'تاريخ الإصدار'], ['range', 'نطاق الرصد']] },
  { title: 'الملف الشخصي', keys: [['displayName', 'الاسم الظاهر'], ['bio', 'النبذة'], ['verifiedBadge', 'علامة التوثيق'], ['followers', 'عدد المتابعين'], ['program', 'البرنامج المرتبط'], ['profileSnapshot', 'تاريخ بيانات الملف']] },
  { title: 'المؤشرات', keys: [['figures', 'قسم المؤشرات'], ['sentimentBar', 'شريط توزيع المشاعر'], ['figureNotes', 'ملاحظات تفسير الأرقام']] },
  { title: 'التفاعلات', keys: [['interactions', 'قسم أحدث التفاعلات'], ['postBadges', 'وسوم التصنيف'], ['postProgram', 'برنامج التفاعل'], ['postLinks', 'رابط التفاعل الأصلي']] },
  { title: 'التذييل', keys: [['footerText', 'نص التذييل'], ['pageNumbers', 'أرقام الصفحات (PDF)']] },
];

/** A thumbnail through the authenticated image loader (an <img src> would not carry the session token). */
function AssetThumb({ id, alt }: { id: string; alt: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const img = useQuery({ queryKey: ['influencer-card-asset', id], queryFn: () => loadCardAsset(id), staleTime: Infinity });
  useEffect(() => {
    const c = ref.current, b = img.data;
    if (!c || !b) return;
    const k = Math.min(160 / b.width, 96 / b.height);
    c.width = Math.max(1, Math.round(b.width * k)); c.height = Math.max(1, Math.round(b.height * k));
    c.getContext('2d')!.drawImage(b, 0, 0, c.width, c.height);
  }, [img.data]);
  return img.data ? <canvas ref={ref} role="img" aria-label={alt} /> : <span className="text-xs muted">{img.isLoading ? '…' : 'تعذّر التحميل'}</span>;
}

function AssetPicker({ assets, kind, value, onPick, onUpload, disabled }: {
  assets: CardAsset[]; kind: 'logo' | 'background'; value: string | null; onPick: (id: string | null) => void;
  onUpload: (file: File) => Promise<void>; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!pending) { setPreview(null); return; }
    const url = URL.createObjectURL(pending); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending]);
  const list = assets.filter((a) => a.kind === kind);
  return (
    <div className="studio-field" style={{ gridColumn: '1 / -1' }}>
      <span style={{ fontWeight: 600 }}>{kind === 'logo' ? 'الشعار' : 'صورة الخلفية'}</span>
      <div className="studio-assets" role="group" aria-label={kind === 'logo' ? 'الشعارات المتاحة' : 'صور الخلفية المتاحة'}>
        <button type="button" className="studio-asset" aria-pressed={!value} disabled={disabled} onClick={() => onPick(null)}>بدون</button>
        {list.map((a) => (
          <button key={a.id} type="button" className="studio-asset" aria-pressed={value === a.id} disabled={disabled} onClick={() => onPick(a.id)}
            title={`${a.original_name ?? ''} ${a.width}×${a.height}`}>
            <AssetThumb id={a.id} alt={a.original_name ?? 'صورة'} />
          </button>
        ))}
      </div>
      {!disabled && (
        <div className="flex items-center gap-2">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => input.current?.click()} data-testid={`upload-${kind}`}>
            <Upload size={14} /> {busy ? 'جارٍ الرفع…' : 'رفع صورة'}
          </button>
          <small className="muted">PNG أو JPEG أو WebP، حتى 1 ميغابايت بعد التحويل، 16–4096 بكسل. لا يُقبل SVG.</small>
          <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" data-testid={`upload-${kind}-input`}
            onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = '';
              if (!file) return;
              setError(null);
              try { validateCardAssetFile(file); setPending(file); } catch (err) { setError((err as Error).message); setPending(null); }
            }} />
        </div>
      )}
      {pending && preview && <div className="flex flex-wrap items-center gap-2" data-testid={`pending-${kind}`}>
        <img src={preview} alt="معاينة الصورة قبل الرفع" style={{ maxWidth: 180, maxHeight: 100, objectFit: 'contain' }} />
        <button className="btn-primary" disabled={busy || disabled} onClick={async () => {
          setBusy(true); setError(null);
          try { await onUpload(pending); setPending(null); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>اعتماد رفع الصورة</button>
        <button className="btn-ghost" disabled={busy} onClick={() => setPending(null)}>إلغاء الرفع</button>
      </div>}
      {error && <small className="studio-error" role="alert">{error}</small>}
    </div>
  );
}

export default function TemplateEditor({ tab, config, onChange, errors, disabled, assets, onUpload }: {
  tab: EditorTab; config: C; onChange: (next: C) => void; errors: Record<string, string>; disabled: boolean;
  assets: CardAsset[]; onUpload: (file: File, kind: 'logo' | 'background') => Promise<string>;
}) {
  const set = <K extends keyof C>(key: K, value: Partial<C[K]>) => onChange({ ...config, [key]: Array.isArray(value) ? value : { ...(config[key] as object), ...value } });
  const e = (path: string) => errors[path];
  const design = resolveCardDesign(config);
  const designSet = (value: Partial<typeof design>) => onChange({ ...config, design: { ...design, ...value } });

  if (tab === 'colors') return (
    <>
      {COLOR_GROUPS.map((g) => (
        <div key={g.title} className="studio-group">
          <div className="studio-group-title">{g.title}</div>
          {g.keys.map(([k, label]) => (
            <ColorField key={k} label={label} value={config.colors[k]} disabled={disabled} error={e(`colors.${k}`)} onChange={(v) => set('colors', { [k]: v })} />
          ))}
        </div>
      ))}
    </>
  );

  if (tab === 'fonts') {
    const ty = config.typography;
    const font = (v: Partial<C['typography']>) => set('typography', v);
    return (
      <>
        <div className="studio-group">
          <div className="studio-group-title">نوع الخط (خطوط مفتوحة الترخيص OFL، مضمّنة في المنصة)</div>
          <SelectField label="الخط العربي" value={ty.arabicFont} disabled={disabled} onChange={(v) => font({ arabicFont: v })}
            options={CARD_ARABIC_FONTS.map((f) => ({ value: f, label: CARD_FONT_LABELS[f] }))} />
          <SelectField label="الخط الإنجليزي" value={ty.latinFont} disabled={disabled} onChange={(v) => font({ latinFont: v })}
            options={CARD_LATIN_FONTS.map((f) => ({ value: f, label: CARD_FONT_LABELS[f] }))} />
        </div>
        <div className="studio-group">
          <div className="studio-group-title">الأحجام (بكسل)</div>
          <RangeField label="عنوان الترويسة" value={ty.headerTitleSize} min={16} max={28} disabled={disabled} onChange={(v) => font({ headerTitleSize: v })} error={e('typography.headerTitleSize')} />
          <RangeField label="اسم الحساب" value={ty.handleSize} min={16} max={28} disabled={disabled} onChange={(v) => font({ handleSize: v })} />
          <RangeField label="اسم المؤثر" value={ty.nameSize} min={12} max={18} disabled={disabled} onChange={(v) => font({ nameSize: v })} />
          <RangeField label="نص التفاعلات" value={ty.bodySize} min={11} max={16} disabled={disabled} onChange={(v) => font({ bodySize: v })} />
          <RangeField label="النصوص الصغيرة" value={ty.smallSize} min={10} max={13} disabled={disabled} onChange={(v) => font({ smallSize: v })} />
          <RangeField label="أرقام المؤشرات" value={ty.statValueSize} min={16} max={28} disabled={disabled} onChange={(v) => font({ statValueSize: v })} />
        </div>
        <div className="studio-group">
          <div className="studio-group-title">الوزن والتباعد</div>
          <SelectField label="وزن العناوين" value={ty.titleWeight} disabled={disabled} onChange={(v) => font({ titleWeight: v })}
            options={[{ value: 500, label: 'متوسط (500)' }, { value: 600, label: 'شبه عريض (600)' }, { value: 700, label: 'عريض (700)' }]} />
          <SelectField label="وزن النصوص" value={ty.bodyWeight} disabled={disabled} onChange={(v) => font({ bodyWeight: v })}
            options={[{ value: 400, label: 'عادي (400)' }, { value: 500, label: 'متوسط (500)' }]} />
          <RangeField label="ارتفاع السطر" value={ty.lineHeight} min={1.4} max={2} step={0.05} disabled={disabled} onChange={(v) => font({ lineHeight: Number(v.toFixed(2)) })} unit="×" />
          <SelectField label="محاذاة نص التفاعلات" value={design.align} disabled={disabled} onChange={align => designSet({ align })}
            options={[{ value: 'auto', label: 'حسب اتجاه النص' }, { value: 'right', label: 'يمين' }, { value: 'center', label: 'وسط' }, { value: 'left', label: 'يسار' }]} />
        </div>
      </>
    );
  }

  if (tab === 'brand') {
    const upload = async (file: File, kind: 'logo' | 'background') => {
      const id = await onUpload(file, kind);
      if (kind === 'logo') set('logo', { assetId: id }); else set('background', { imageAssetId: id });
    };
    return (
      <>
        <div className="studio-group">
          <div className="studio-group-title">الشعار</div>
          <SelectField label="نمط البطاقة" value={design.style ?? 'classic'} disabled={disabled} onChange={(style) => designSet({ style })}
            options={CARD_STYLES.map((value) => ({ value, label: CARD_STYLE_LABELS[value] }))} />
          <ToggleField label="إظهار الشعار" checked={design.logoShow} disabled={disabled} onChange={logoShow => designSet({ logoShow })} />
          <ToggleField label="الشعار المدمج عند عدم اختيار شعار (NHC في نمط الهوية)" checked={design.defaultLogo} disabled={disabled} onChange={defaultLogo => designSet({ defaultLogo })} />
          <RangeField label="هامش الشعار" value={design.logoMargin} min={0} max={24} disabled={disabled} onChange={logoMargin => designSet({ logoMargin })} />
          <AssetPicker assets={assets} kind="logo" value={config.logo.assetId} disabled={disabled} onPick={(id) => set('logo', { assetId: id })} onUpload={(f) => upload(f, 'logo')} />
          <SelectField label="موضع الشعار" value={config.logo.position} disabled={disabled} onChange={(v) => set('logo', { position: v })}
            options={[{ value: 'start', label: 'يمين الترويسة (بجانب العنوان)' }, { value: 'end', label: 'يسار الترويسة' }]} />
          <RangeField label="ارتفاع الشعار" value={config.logo.height} min={20} max={120} unit="px" disabled={disabled} onChange={(v) => set('logo', { height: v })} />
        </div>
        <div className="studio-group">
          <div className="studio-group-title">خلفية البطاقة والزخارف</div>
          <ToggleField label="تدرج لوني للخلفية" checked={design.gradient} disabled={disabled} onChange={gradient => designSet({ gradient })} />
          <ColorField label="لون نهاية التدرج" value={design.gradientEnd} disabled={disabled} onChange={gradientEnd => designSet({ gradientEnd })} />
          <SelectField label="اتجاه التدرج" value={design.gradientDirection} disabled={disabled} onChange={gradientDirection => designSet({ gradientDirection })}
            options={[{ value: 'vertical', label: 'عمودي' }, { value: 'horizontal', label: 'أفقي' }]} />
          <RangeField label="عتامة التدرج" value={design.gradientOpacity * 100} min={0} max={100} unit="%" disabled={disabled} onChange={v => designSet({ gradientOpacity: v / 100 })} />
          <RangeField label="تعتيم صورة الخلفية" value={design.imageDim * 100} min={0} max={80} unit="%" disabled={disabled} onChange={v => designSet({ imageDim: v / 100 })} />
          <AssetPicker assets={assets} kind="background" value={config.background.imageAssetId} disabled={disabled}
            onPick={(id) => set('background', { imageAssetId: id })} onUpload={(f) => upload(f, 'background')} />
          <RangeField label="شفافية صورة الخلفية" value={Math.round(config.background.imageOpacity * 100)} min={0} max={50} unit="%" disabled={disabled}
            onChange={(v) => set('background', { imageOpacity: v / 100 })} />
          <SelectField label="زخرفة الخلفية" value={config.background.decoration} disabled={disabled} onChange={(v) => set('background', { decoration: v })}
            options={[{ value: 'none', label: 'بدون' }, { value: 'lattice', label: 'شبكة' }, { value: 'diagonal', label: 'خطوط مائلة' }, { value: 'dots', label: 'نقاط' }]} />
          <RangeField label="شفافية الزخرفة" value={Math.round(config.background.decorationOpacity * 100)} min={0} max={30} unit="%" disabled={disabled}
            onChange={(v) => set('background', { decorationOpacity: v / 100 })} />
          <SelectField label="نقش التذييل" value={config.background.footerPattern} disabled={disabled} onChange={(v) => set('background', { footerPattern: v })}
            options={[{ value: 'lattice', label: 'شبكة' }, { value: 'diagonal', label: 'خطوط مائلة' }, { value: 'plain', label: 'سادة' }, { value: 'leaves', label: 'أوراق NHC' }, { value: 'vines', label: 'أغصان NHC (الشريط الأخضر)' }]} />
        </div>
      </>
    );
  }

  if (tab === 'layout') {
    const move = (i: number, d: -1 | 1) => {
      const stats = [...config.stats]; const j = i + d;
      if (j < 0 || j >= stats.length) return;
      [stats[i], stats[j]] = [stats[j], stats[i]];
      onChange({ ...config, stats });
    };
    return (
      <>
        <div className="studio-group">
          <div className="studio-group-title">الهوامش والمسافات</div>
          <RangeField label="هامش الصفحة" value={config.layout.padding} min={16} max={48} unit="px" disabled={disabled} onChange={(v) => set('layout', { padding: v })} />
          <RangeField label="المسافة بين الأقسام" value={config.layout.gap} min={8} max={24} unit="px" disabled={disabled} onChange={(v) => set('layout', { gap: v })} />
          <RangeField label="استدارة الزوايا" value={config.layout.radius} min={0} max={24} unit="px" disabled={disabled} onChange={(v) => set('layout', { radius: v })} />
          <RangeField label="أعمدة الإحصائيات (تتكيف مع العرض)" value={design.statColumns} min={1} max={6} disabled={disabled} onChange={statColumns => designSet({ statColumns })} />
        </div>
        <div className="studio-group" style={{ gridTemplateColumns: '1fr' }}>
          <div className="studio-group-title">ترتيب أقسام البطاقة</div>
          <p className="text-xs muted">الترويسة والشعار في الأعلى والتذييل في الأسفل. صورة المؤثر والاسم ومعلوماته مجموعة متجاوبة واحدة؛ يمكن إخفاء تفاصيلها من المحتوى.</p>
          {design.sections.map((section, i) => {
            const moveSection = (delta: number) => {
              const sections = [...design.sections]; const j = i + delta;
              if (j < 0 || j >= sections.length) return;
              [sections[i], sections[j]] = [sections[j], sections[i]]; designSet({ sections });
            };
            return <div className="studio-stat" key={section.key} data-testid={`section-${section.key}`}>
              <ToggleField label={CARD_SECTION_LABELS[section.key]} checked={section.show} disabled={disabled} onChange={show => designSet({ sections: design.sections.map(s => s.key === section.key ? { ...s, show } : s) })} />
              <button className="icon-button" aria-label={`تقديم قسم ${CARD_SECTION_LABELS[section.key]}`} disabled={disabled || i === 0} onClick={() => moveSection(-1)}><ArrowUp size={14} /></button>
              <button className="icon-button" aria-label={`تأخير قسم ${CARD_SECTION_LABELS[section.key]}`} disabled={disabled || i === design.sections.length - 1} onClick={() => moveSection(1)}><ArrowDown size={14} /></button>
            </div>;
          })}
        </div>
        <div className="studio-group">
          <div className="studio-group-title">صورة المؤثر</div>
          <ToggleField label="إظهار الصورة الشخصية" checked={config.avatar.show} disabled={disabled} onChange={(v) => set('avatar', { show: v })} />
          <SelectField label="الشكل" value={config.avatar.shape} disabled={disabled} onChange={(v) => set('avatar', { shape: v })}
            options={[{ value: 'circle', label: 'دائري' }, { value: 'rounded', label: 'مربع بزوايا مستديرة' }]} />
          <RangeField label="الحجم (نصف القطر)" value={config.avatar.size} min={32} max={72} unit="px" disabled={disabled} onChange={(v) => set('avatar', { size: v })} />
        </div>
        <div className="studio-group">
          <div className="studio-group-title">ترتيب المؤشرات وإظهارها (من اليمين)</div>
          <div className="studio-stats" data-testid="stats-order">
            {config.stats.map((s, i) => (
              <div key={s.key} className="studio-stat">
                <ToggleField label={CARD_STAT_LABELS[s.key]} checked={s.show} disabled={disabled}
                  onChange={(v) => onChange({ ...config, stats: config.stats.map((x) => (x.key === s.key ? { ...x, show: v } : x)) })} />
                <button type="button" className="icon-button" aria-label={`تقديم ${CARD_STAT_LABELS[s.key]}`} disabled={disabled || i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                <button type="button" className="icon-button" aria-label={`تأخير ${CARD_STAT_LABELS[s.key]}`} disabled={disabled || i === config.stats.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
              </div>
            ))}
          </div>
          {errors.stats && <small className="studio-error">{errors.stats}</small>}
        </div>
      </>
    );
  }

  if (tab === 'content') return (
    <>
      <p className="text-xs muted">إخفاء عنصر يغيّر شكل البطاقة فقط؛ لا تتغير البيانات ولا الأرقام المحسوبة.</p>
      {VISIBILITY.map((g) => (
        <div key={g.title} className="studio-group">
          <div className="studio-group-title">{g.title}</div>
          {g.keys.map(([k, label]) => (
            <ToggleField key={k} label={label} checked={config.visibility[k]} disabled={disabled} onChange={(v) => set('visibility', { [k]: v })} />
          ))}
        </div>
      ))}
    </>
  );

  if (tab === 'text') return (
    <div className="studio-group" style={{ gridTemplateColumns: '1fr' }}>
      <p className="text-xs muted">نص عادي فقط؛ لا تُقبل الوسوم أو الأكواد أو محارف التحكم.</p>
      <TextField label="عنوان الترويسة" value={config.text.headerTitle} maxLength={40} disabled={disabled} error={e('text.headerTitle')}
        onChange={(v) => set('text', { headerTitle: v })} />
      <TextField label="العنوان الفرعي" value={config.text.headerSubtitle} maxLength={60} disabled={disabled} error={e('text.headerSubtitle')}
        onChange={(v) => set('text', { headerSubtitle: v })} />
      <TextField label="نص التذييل" value={config.text.footerText} maxLength={120} disabled={disabled} error={e('text.footerText')}
        onChange={(v) => set('text', { footerText: v })} />
      {([['figuresTitle', 'عنوان الإحصائيات'], ['interactionsTitle', 'عنوان التفاعلات'], ['summaryTitle', 'عنوان الملخص'], ['summaryText', 'النص التوضيحي الثابت'], ['additionalTitle', 'عنوان المعلومات الإضافية'], ['additionalText', 'نص المعلومات الإضافية']] as const).map(([key, label]) =>
        <TextField key={key} label={label} value={design[key]} maxLength={key.endsWith('Text') ? 500 : 60} disabled={disabled} error={e(`design.${key}`)} onChange={v => designSet({ [key]: v })} />)}
      <p className="text-xs muted">النصوص هنا ثابتة للهوية فقط؛ لا تستبدل بيانات المؤثر أو قيم الإحصائيات.</p>
      {Object.entries(CARD_STAT_LABELS).map(([key, label]) => <TextField key={key} label={`تسمية ${label}`} value={design.statLabels[key as keyof typeof design.statLabels]} maxLength={50} disabled={disabled}
        onChange={value => designSet({ statLabels: { ...design.statLabels, [key]: value } })} />)}
    </div>
  );

  return (
    <div className="studio-group">
      <div className="studio-group-title">القيم الافتراضية عند التصدير (يمكن تغييرها في نافذة التصدير)</div>
      <SelectField label="عرض صورة PNG" value={config.output.pngWidth} disabled={disabled} onChange={(v) => set('output', { pngWidth: v })}
        options={[720, 820, 960, 1080].map((w) => ({ value: w as 720, label: `${w} بكسل` }))} />
      <SelectField label="دقة PNG" value={config.output.pngScale} disabled={disabled} onChange={(v) => set('output', { pngScale: v })}
        options={[{ value: 2 as const, label: '2× (عالية)' }, { value: 3 as const, label: '3× (عالية جداً)' }]} />
      <SelectField label="اتجاه PDF ‏(A4)" value={config.output.pdfOrientation} disabled={disabled} onChange={(v) => set('output', { pdfOrientation: v })}
        options={[{ value: 'portrait', label: 'عمودي' }, { value: 'landscape', label: 'أفقي' }]} />
    </div>
  );
}
