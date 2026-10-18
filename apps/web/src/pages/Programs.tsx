import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PERMISSIONS as P } from '@mip/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useConfirmAction } from '../components/ConfirmAction';
import { useActionNotice } from '../components/ActionNotice';

interface Program {
  id: string; key: string; name_ar: string; name_en: string; color: string | null;
  is_active: boolean; service_count: number; keyword_count: number; query_count: number;
}
const empty = { nameAr: '', nameEn: '', key: '', description: '', color: '#0E2A47', isActive: true };

export default function Programs() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const notice = useActionNotice();
  const [form, setForm] = useState(empty);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Program | null>(null);
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });
  const create = useMutation({
    mutationFn: () => api.post<Program>('/programs', form),
    onSuccess: (program) => {
      setCreated(program); setForm(empty); setOpen(false);
      qc.invalidateQueries({ queryKey: ['programs'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  const setActive = (p: Program, isActive: boolean) => api.patch<Program>(`/programs/${p.id}`, { isActive })
    .then(() => { notice.success(isActive ? `فُعّل برنامج «${p.name_ar}».` : `أُوقف برنامج «${p.name_ar}».`); qc.invalidateQueries(); })
    .catch((e) => { notice.error(e); throw e; });
  const field = (key: 'nameAr' | 'nameEn' | 'key' | 'description' | 'color', value: string) => setForm(old => ({ ...old, [key]: value }));
  return <div className="space-y-5" dir="rtl">
    {confirmation.dialog}
    <div className="page-heading flex flex-wrap items-center justify-between gap-3">
      <div><h1>إدارة البرامج</h1><p>برامج الرصد والكلمات المفتاحية والاستعلامات المرتبطة بها.</p></div>
      {can(P.ADMIN_SYSTEM) && <button className="btn-primary" onClick={() => { create.reset(); setOpen(!open); }}>{open ? 'إغلاق' : 'برنامج جديد'}</button>}
    </div>
    {notice.element}
    {created && <div role="status" className="card p-4 space-y-2">
      <p>تم إنشاء برنامج «{created.name_ar}»{created.is_active ? '' : ' (متوقف)'}. الخطوة التالية: أنشئ مجموعات الكلمات وأضف كلماتها.</p>
      <p className="text-sm muted">لن يبدأ جمع بيانات البرنامج تلقائيًا: يُنشأ استعلامه التلقائي موقوفًا عند المزامنة التالية، ولا يعمل حتى تستأنفه من صفحة الاستعلامات.</p>
      <div className="flex flex-wrap gap-2">
        {can(P.KEYWORDS_READ) && <Link className="btn-primary inline-flex" to={`/keywords?programId=${created.id}`}>إعداد قاموس الكلمات</Link>}
        {can(P.QUERIES_WRITE) && <Link className="btn-ghost inline-flex" to={`/queries/new?programId=${created.id}`}>بناء استعلام يدوي</Link>}
      </div>
    </div>}
    {open && can(P.ADMIN_SYSTEM) && <form className="card p-5 space-y-4" onSubmit={e => { e.preventDefault(); if (!create.isPending) create.mutate(); }}>
      <h2 className="font-bold">برنامج جديد</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2"><span>اسم البرنامج بالعربية *</span><input className="input w-full" required maxLength={120} value={form.nameAr} onChange={e => field('nameAr', e.target.value)} /></label>
        <label className="space-y-2"><span>الاسم بالإنجليزية (اختياري)</span><input className="input w-full" dir="ltr" maxLength={120} value={form.nameEn} onChange={e => field('nameEn', e.target.value)} /></label>
        <label className="space-y-2"><span>معرّف البرنامج *</span><input className="input w-full" dir="ltr" required minLength={2} maxLength={64} pattern="[a-z][a-z0-9_-]*" placeholder="new-program" value={form.key} onChange={e => field('key', e.target.value)} /><span className="block text-xs muted">معرّف فريد بحروف إنجليزية صغيرة وأرقام وشرطة.</span></label>
        <label className="space-y-2"><span>لون البرنامج</span><input className="input block w-full" type="color" value={form.color} onChange={e => field('color', e.target.value)} /></label>
      </div>
      <label className="block space-y-2"><span>الوصف (اختياري)</span><textarea className="input w-full" maxLength={1000} value={form.description} onChange={e => field('description', e.target.value)} /></label>
      <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.isActive} onChange={e => setForm(old => ({ ...old, isActive: e.target.checked }))} /><span>البرنامج مفعّل</span></label>
      <p className="text-sm muted">إنشاء البرنامج لا يشغّل جمع البيانات ولا ينشئ استعلامات نشطة. أعدّ القاموس أولًا، ثم استأنف استعلامه التلقائي يدويًا عندما تريد بدء الجمع.</p>
      {create.error && <p role="alert" className="text-red-600">{create.error.message}</p>}
      <button className="btn-primary" disabled={create.isPending || !form.nameAr.trim() || !form.key}>{create.isPending ? 'جارٍ الحفظ…' : 'حفظ البرنامج'}</button>
    </form>}
    {programs.isPending && <p role="status" className="card p-5">جارٍ تحميل البرامج…</p>}
    {programs.error && <div role="alert" className="card p-5 space-y-3"><p className="text-red-600">{programs.error.message}</p><button className="btn-ghost" onClick={() => programs.refetch()}>إعادة المحاولة</button></div>}
    {programs.data && <section className="card overflow-x-auto">
      <table className="w-full text-sm text-start">
        <thead><tr>{['البرنامج', 'المعرّف', 'الحالة', 'الخدمات', 'الكلمات', 'الاستعلامات', ''].map((title, i) => <th key={i} scope="col" className="p-4 text-start whitespace-nowrap">{title}</th>)}</tr></thead>
        <tbody>{programs.data.items.map(p => <tr key={p.id} className="border-t border-[var(--border)]">
          <td className="p-4 font-bold whitespace-nowrap"><span className="inline-block w-3 h-3 rounded-full me-2" style={{ background: p.color ?? '#0E2A47' }} />{p.name_ar}</td>
          <td className="p-4" dir="ltr">{p.key}</td><td className="p-4 whitespace-nowrap">{p.is_active ? 'نشط' : 'متوقف'}</td>
          <td className="p-4">{p.service_count}</td><td className="p-4">{p.keyword_count}</td><td className="p-4">{p.query_count}</td>
          <td className="p-4 whitespace-nowrap"><div className="flex gap-2">
            {can(P.KEYWORDS_READ) && <Link className="btn-ghost" to={`/keywords?programId=${p.id}`}>القاموس</Link>}
            {can(P.QUERIES_WRITE) && <Link className="btn-ghost" to={`/queries/new?programId=${p.id}`}>بناء استعلام</Link>}
            {can(P.PROGRAMS_WRITE) && <button type="button" className="btn-ghost" aria-label={`${p.is_active ? 'إيقاف' : 'تفعيل'} برنامج ${p.name_ar}`}
              onClick={() => confirmation.request(p.is_active
                ? { title: 'إيقاف البرنامج', description: `لن تُنشأ أو تُحدَّث استعلامات تلقائية لبرنامج «${p.name_ar}». الاستعلامات القائمة لا تتوقف بهذا الإجراء؛ أوقفها من صفحة الاستعلامات إن أردت إيقاف الجمع.`, confirmLabel: 'إيقاف البرنامج', danger: true, allowed: can => can(P.PROGRAMS_WRITE), execute: () => setActive(p, false) }
                : { title: 'تفعيل البرنامج', description: `سيُعاد إدراج «${p.name_ar}» في مزامنة القاموس. الاستعلامات الموقوفة تبقى موقوفة حتى تستأنفها.`, confirmLabel: 'تفعيل البرنامج', allowed: can => can(P.PROGRAMS_WRITE), execute: () => setActive(p, true) })}>
              {p.is_active ? 'إيقاف' : 'تفعيل'}
            </button>}
          </div></td>
        </tr>)}</tbody>
      </table>
      {!programs.data.items.length && <p className="p-5 muted">لا توجد برامج بعد.</p>}
    </section>}
  </div>;
}
