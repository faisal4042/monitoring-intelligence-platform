import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, FileDown, Info, LayoutTemplate as LayoutTemplateIcon, Lock, Play, Pause, RotateCcw, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { fmtDateTime, fmtNum } from '../../lib/format';
import { EXPORT_STATUS, EXPORTS_OFF_TEXT, FORMAT_LABELS, SCHEDULES_OFF_TEXT, tablesReady, type Catalog, type ExportRow, type ScheduleRow, type TemplateRow } from '../../lib/reports';
import { exportActions, exportDuration } from '../../lib/report-insights';
import AsyncState from '../AsyncState';
const fmtBytes=(b:number|string|null)=>{const n=Number(b??0);return n>1e6?`${(n/1e6).toFixed(1)} م.ب`:`${Math.max(1,Math.round(n/1e3))} ك.ب`;};

export function ExportsView({ c }: { c: Catalog }) {
  const qc = useQueryClient();
  const [status,setStatus]=useState('all');
  const [page,setPage]=useState(1);
  const list = useQuery({queryKey: ['report-exports'], queryFn: () => api.get<{items: ExportRow[]}>('/reports/exports'), enabled: tablesReady(c) && c.canExport,
    refetchInterval: (q) => (q.state.data?.items ?? []).some((e) => e.status === 'queued' || e.status === 'running') ? 3000 : false});
  const act = useMutation({mutationFn: ({id, action}: {id: string; action: 'cancel' | 'retry'}) => api.post(`/reports/exports/${id}/${action}`),
    onSettled: () => qc.invalidateQueries({queryKey: ['report-exports']})});
  const download = useMutation({mutationFn: (id: string) => api.post<{url: string}>(`/reports/exports/${id}/link`), onSuccess: (r) => { window.location.assign(r.url); }});
  if (!tablesReady(c)) return <Off title="سجل التصدير" text="محرك التصدير غير مفعّل على قاعدة البيانات هذه بعد (الترحيل 0047 بانتظار الاعتماد)." />;
  if (!c.canExport) return <Off title="سجل التصدير" text="عرض سجل التصدير يتطلب صلاحية تصدير التقارير." />;
  const err = (act.error ?? download.error) as ApiError | null;
  const filtered=(list.data?.items??[]).filter(e=>status==='all'||e.status===status);
  const pages=Math.max(1,Math.ceil(filtered.length/10));
  const current=Math.min(page,pages);
  const visible=filtered.slice((current-1)*10,current*10);
  return (
    <>
      <h2 className="rc-h2">سجل التصدير</h2>
      <p className="rc-desc">الملفات تُنشأ في الخلفية وتنتهي صلاحيتها تلقائيًا. رابط التنزيل مؤقت ومرتبط بحسابك، ويُسجَّل كل تنزيل.</p>
      {!c.exportsActivated && <p className="rc-note" role="status"><Info size={14} aria-hidden="true" /> {EXPORTS_OFF_TEXT} الطلبات المسجلة سابقًا لن تُعالَج ما دام التصدير معطلًا.</p>}
      {err && <p className="rc-error" role="alert">{err.message}</p>}
      <div className="rc-history-tools"><label><span className="sr-only">تصفية سجل التصدير حسب الحالة</span><select className="input" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="all">جميع الحالات</option>{Object.entries(EXPORT_STATUS).map(([key,s])=><option key={key} value={key}>{s.label}</option>)}</select></label><button className="btn-ghost" disabled={list.isFetching} onClick={()=>list.refetch()}>تحديث السجل</button><span className="rc-meta">سجلك الشخصي · آخر 100 عملية كحد أقصى</span></div>
      {act.isSuccess && <p className="rc-ok" role="status">تم تسجيل الإجراء وتحديث سجل التصدير.</p>}

      {list.error ? <AsyncState error={list.error} errorMessage="تعذر تحميل سجل التصدير." onRetry={()=>list.refetch()} /> : list.isLoading ? <div className="rc-skeleton" aria-label="جارٍ تحميل سجل التصدير" aria-busy="true" /> : !filtered.length ? <div className="rc-state"><p>لا توجد عمليات تصدير ضمن الحالة المحددة.</p></div> : (
        <div className="rc-table-wrap" tabIndex={0} role="region" aria-label="سجل التصدير">
          <table className="rc-table rc-exports">
            <thead><tr><th scope="col">التقرير</th><th scope="col">الصيغة</th><th scope="col">صاحب الطلب</th><th scope="col">الحالة</th><th scope="col">السجلات</th><th scope="col">مدة التنفيذ</th><th scope="col">الحجم</th><th scope="col">الإنشاء</th><th scope="col">ينتهي</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
            <tbody>{visible.map((e) => {
              const st = EXPORT_STATUS[e.status];
              const allowed=exportActions(c,e);
              const seconds=exportDuration(e);
              const type = c.types.find((t) => t.key === e.report_type);
              const est = e.rows_estimate === null ? null : Number(e.rows_estimate);
              const pct = e.status === 'running' && est ? Math.min(99, Math.round(Number(e.rows_written) / est * 100)) : null;
              return (
                <tr key={e.id}>
                  <td><b>{type?.ar ?? e.report_type}</b>{e.error && <small className="rc-row-error">{e.error}</small>}</td>
                  <td>{FORMAT_LABELS[e.format]}{e.parts && e.parts > 1 ? <small className="num"> · {e.parts} أجزاء</small> : null}</td>
                  <td>{e.requested_by_name}</td><td><span className={`rc-status-pill tone-${st.tone}`}>{st.label}</span>{pct !== null && <span className="rc-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{width: `${pct}%`}} /></span>}</td>
                  <td className="num">{fmtNum(Number(e.rows_written))}{est !== null && e.status !== 'succeeded' ? <small> / {fmtNum(est)}</small> : null}</td>
                  <td>{seconds===null?'—':`${fmtNum(Math.round(seconds*10)/10)} ثانية`}</td>
                  <td className="num">{e.file_bytes ? fmtBytes(e.file_bytes) : '—'}</td>
                  <td>{fmtDateTime(e.created_at)}</td>
                  <td>{e.expires_at ? fmtDateTime(e.expires_at) : '—'}</td>
                  <td className="rc-row-actions">
                    {allowed.download && <button type="button" className="btn-ghost" onClick={() => download.mutate(e.id)} disabled={download.isPending}><FileDown size={15} aria-hidden="true" /> تنزيل</button>}
                    {allowed.cancel && <button type="button" className="btn-ghost" disabled={act.isPending} onClick={() => act.mutate({id: e.id, action: 'cancel'})}><X size={15} aria-hidden="true" /> إلغاء</button>}
                    {allowed.retry && <button type="button" className="btn-ghost" disabled={act.isPending} onClick={() => act.mutate({id: e.id, action: 'retry'})}><RotateCcw size={15} aria-hidden="true" /> إعادة</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {!list.error && filtered.length>0 && <div className="rc-pagination"><span>{fmtNum(filtered.length)} عملية · الصفحة {fmtNum(current)} من {fmtNum(pages)}</span><div><button className="btn-ghost" disabled={current===1} onClick={()=>setPage(current-1)}>السابق</button><button className="btn-ghost" disabled={current===pages} onClick={()=>setPage(current+1)}>التالي</button></div></div>}
    </>
  );
}

export function TemplatesView({ c, onUse }: { c: Catalog; onUse: (t: TemplateRow) => void }) {
  const qc = useQueryClient();
  const list = useQuery({queryKey: ['report-templates'], queryFn: () => api.get<{items: TemplateRow[]}>('/reports/templates'), enabled: tablesReady(c)});
  const del = useMutation({mutationFn: (id: string) => api.del(`/reports/templates/${id}`), onSettled: () => qc.invalidateQueries({queryKey: ['report-templates']})});
  if (!tablesReady(c)) return <Off title="قوالب التقارير" text="القوالب تتطلب تفعيل الترحيل 0047." />;
  return (
    <>
      <h2 className="rc-h2">قوالب التقارير</h2>
      <p className="rc-desc">احفظ القالب من منشئ أي تقرير. كل تعديل على التعريف ينشئ إصدارًا جديدًا يُسجَّل مع كل تصدير.</p>
      {del.error && <p className="rc-error" role="alert">{(del.error as ApiError).message}</p>}
      {list.error ? <AsyncState error={list.error} errorMessage="تعذر تحميل القوالب المحفوظة." onRetry={()=>list.refetch()} /> : list.isLoading ? <div className="rc-skeleton" aria-label="جارٍ تحميل القوالب" aria-busy="true" /> : !list.data?.items.length ? <div className="rc-state"><LayoutTemplateIcon /><h3>قوالبك، جاهزة للاستخدام من جديد</h3><p>احفظ إعدادات تقرير من مساحة المعاينة لتظهر هنا.</p></div> : (
        <div className="rc-cards">{list.data.items.map((t) => (
          <article key={t.id} className="rc-card">
            <div className="rc-card-head"><h3>{t.name}</h3><span className="rc-tag">{t.visibility === 'shared' ? 'مشترك' : 'خاص'} · إصدار <span className="num">{t.version}</span></span></div>
            <p>{c.types.find((x) => x.key === t.report_type)?.ar ?? t.report_type} · {t.definition.request.columns.length} عمودًا · {FORMAT_LABELS[t.definition.options.format]}</p>
            <div className="rc-card-foot"><span className="rc-meta">{t.owner_name} · {fmtDateTime(t.updated_at)}</span>
              <span className="rc-row-actions">
                <button type="button" className="btn-primary rc-open" disabled={!c.types.some(x=>x.key===t.report_type&&x.available)} onClick={() => onUse(t)}>استخدام القالب</button>
                {t.is_owner && <button type="button" className="btn-ghost" disabled={del.isPending} onClick={() => {if(window.confirm(`حذف القالب «${t.name}»؟`))del.mutate(t.id);}}>حذف</button>}
              </span></div>
          </article>
        ))}</div>
      )}
    </>
  );
}

const WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export function SchedulesView({ c }: { c: Catalog }) {
  const qc = useQueryClient();
  const templates = useQuery({queryKey: ['report-templates'], queryFn: () => api.get<{items: TemplateRow[]}>('/reports/templates'), enabled: tablesReady(c) && c.canSchedule && !!c.schedulesActivated});
  const list = useQuery({queryKey: ['report-schedules'], queryFn: () => api.get<{items: ScheduleRow[]}>('/reports/schedules'), enabled: tablesReady(c) && c.canSchedule && !!c.schedulesActivated});
  const [form, setForm] = useState({templateId: '', name: '', cadence: 'daily' as ScheduleRow['cadence'], runAtLocal: '07:00', weekday: 0, monthday: 1, format: 'xlsx'});
  const create = useMutation({mutationFn: () => api.post('/reports/schedules', {...form, weekday: form.cadence === 'weekly' ? form.weekday : null, monthday: form.cadence === 'monthly' ? form.monthday : null}),
    onSuccess: () => { setForm({...form, name: ''}); qc.invalidateQueries({queryKey: ['report-schedules']}); }});
  const toggle = useMutation({mutationFn: ({id, on}: {id: string; on: boolean}) => api.post(`/reports/schedules/${id}/${on ? 'activate' : 'deactivate'}`), onSettled: () => qc.invalidateQueries({queryKey: ['report-schedules']})});
  if (!tablesReady(c)) return <Off title="التقارير المجدولة" text="الجدولة تتطلب تفعيل الترحيل 0047." />;
  if (!c.canSchedule) return <Off title="التقارير المجدولة" text="الجدولة تتطلب صلاحية إدارة جدولة التقارير." />;
  if (!c.schedulesActivated) return <Off title="الجدولة غير مفعّلة" text={SCHEDULES_OFF_TEXT} />;
  return (
    <>
      <h2 className="rc-h2">التقارير المجدولة</h2>
      <p className="rc-desc">تُنشئ الجدولة تصديرًا في السجل لكل فترة مرة واحدة فقط (بتوقيت الرياض). لا يُرسل بريد أو تيليجرام من هذه الخاصية حاليًا.</p>
      {!c.schedulesActivated && <p className="rc-note" role="status"><Info size={14} aria-hidden="true" /> {SCHEDULES_OFF_TEXT}</p>}
      {c.schedulesActivated && <form className="rc-panel rc-schedule-form" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label className="rc-field"><span>القالب</span><select className="input" required value={form.templateId} onChange={(e) => setForm({...form, templateId: e.target.value})}>
          <option value="">اختر قالبًا</option>{templates.data?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="rc-field"><span>الاسم</span><input className="input" required maxLength={120} value={form.name} onChange={(e) => setForm({...form, name: e.target.value})} /></label>
        <label className="rc-field"><span>التكرار</span><select className="input" value={form.cadence} onChange={(e) => setForm({...form, cadence: e.target.value as ScheduleRow['cadence']})}>
          <option value="daily">يومي (اليوم السابق)</option><option value="weekly">أسبوعي (آخر 7 أيام)</option><option value="monthly">شهري (الشهر السابق)</option></select></label>
        {form.cadence === 'weekly' && <label className="rc-field"><span>اليوم</span><select className="input" value={form.weekday} onChange={(e) => setForm({...form, weekday: Number(e.target.value)})}>{WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
        {form.cadence === 'monthly' && <label className="rc-field"><span>يوم الشهر</span><input type="number" min={1} max={28} className="input num" value={form.monthday} onChange={(e) => setForm({...form, monthday: Number(e.target.value)})} /></label>}
        <label className="rc-field"><span>الوقت (الرياض)</span><input type="time" className="input num" value={form.runAtLocal} onChange={(e) => setForm({...form, runAtLocal: e.target.value})} /></label>
        <label className="rc-field"><span>الصيغة</span><select className="input" value={form.format} onChange={(e) => setForm({...form, format: e.target.value})}>{c.formats.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}</select></label>
        <button className="btn-primary" disabled={!form.templateId || !form.name.trim() || create.isPending}>إضافة الجدولة</button>
      </form>}
      {(create.error ?? toggle.error) && <p className="rc-error" role="alert">{((create.error ?? toggle.error) as ApiError).message}</p>}
      {!list.data?.items.length ? <div className="rc-state"><p>لا توجد جدولة بعد.</p></div> : (
        <div className="rc-table-wrap" tabIndex={0} role="region" aria-label="الجدولة">
          <table className="rc-table"><thead><tr><th scope="col">الاسم</th><th scope="col">القالب</th><th scope="col">التكرار</th><th scope="col">التشغيل القادم</th><th scope="col">التشغيلات</th><th scope="col">الحالة</th><th scope="col"><span className="sr-only">إجراءات</span></th></tr></thead>
            <tbody>{list.data.items.map((s) => (
              <tr key={s.id}><td><b>{s.name}</b>{s.last_error && <small className="rc-row-error">{s.last_error}</small>}</td><td>{s.template_name}</td>
                <td>{s.cadence === 'daily' ? 'يومي' : s.cadence === 'weekly' ? `أسبوعي · ${WEEKDAYS[s.weekday ?? 0]}` : `شهري · ${s.monthday}`} <span className="num">{s.run_at_local.slice(0, 5)}</span></td>
                <td>{fmtDateTime(s.next_run_at)}</td><td className="num">{s.runs}</td>
                <td><span className={`rc-status-pill tone-${s.is_active ? 'ok' : 'muted'}`}>{s.is_active ? 'نشطة' : 'موقوفة'}</span>{s.failure_count > 0 && <small className="num"> · {s.failure_count} فشل</small>}</td>
                <td className="rc-row-actions">{(s.is_active || c.schedulesActivated) && <button type="button" className="btn-ghost" onClick={() => toggle.mutate({id: s.id, on: !s.is_active})}>{s.is_active ? <><Pause size={14} aria-hidden="true" /> إيقاف</> : <><Play size={14} aria-hidden="true" /> تفعيل</>}</button>}</td></tr>
            ))}</tbody></table>
        </div>
      )}
    </>
  );
}

function Off({ title, text }: { title: string; text: string }) {
  return <><h2 className="rc-h2">{title}</h2><div className="rc-state"><Lock size={22} aria-hidden="true" /><p>{text}</p></div></>;
}
