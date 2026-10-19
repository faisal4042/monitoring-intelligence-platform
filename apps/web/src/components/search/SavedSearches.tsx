import { useConfirmAction } from '../ConfirmAction';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2, Link2, Lock, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import { SEARCH_ENTITY_LABELS, type SearchEntity } from '@mip/shared';
import { api, ApiError } from '../../lib/api';
import DateTime from '../DateTime';
import { searchHref, type SavedSearch } from '../../lib/search';

import { Button } from '../ui/Button';
/**
 * Saved searches: definitions only (query, tab, period, sort) — never copies
 * of results. Running one re-applies the runner's own permissions; a shared
 * search is read-only for everyone but its owner.
 */
export default function SavedSearches({ available, reason, current, onRun }: {
  available: boolean; reason?: string;
  current: { q: string; tab: SearchEntity; period: Record<string, string>; sort: string };
  onRun: (s: SavedSearch) => void;
}) {
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const list = useQuery({ queryKey: ['saved-searches'], queryFn: () => api.get<{ items: SavedSearch[] }>('/search/saved'), enabled: available });
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['saved-searches'] });
  const create = useMutation({
    mutationFn: () => api.post('/search/saved', { name: name.trim(), query: current.q, tab: current.tab, period: current.period, sort: current.sort || null, visibility: shared ? 'shared' : 'private' }),
    onSuccess: () => { setName(''); refresh(); },
  });
  const patch = useMutation({ mutationFn: (v: { id: string; body: object }) => api.patch(`/search/saved/${v.id}`, v.body), onSuccess: () => { setEditing(null); refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/search/saved/${id}`), onSuccess: refresh });
  const run = useMutation({ mutationFn: (id: string) => api.post<SavedSearch>(`/search/saved/${id}/run`), onSuccess: (s) => { refresh(); onRun(s); } });
  const copy = (s: SavedSearch) => navigator.clipboard?.writeText(location.origin + searchHref(s.query, s.tab, Object.fromEntries(Object.entries(s.period).filter(([, v]) => v)) as Record<string, string>)).catch(() => {});
  const err = (create.error ?? patch.error ?? remove.error ?? run.error) as ApiError | null;

  return (
    <div className="as-saved">
      {confirmation.dialog}
      {!available ? <div className="inf-state">{reason}</div> : <>
        <form className="as-save-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="اسم للبحث الحالي" aria-label="اسم البحث المحفوظ" />
          <label className="inf-check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> مشترك مع المستخدمين</label>
          <Button variant="primary" type="submit" disabled={!name.trim() || create.isPending}>حفظ البحث الحالي</Button>
          <p className="as-note">يُحفظ تعريف الاستعلام فقط. المشترك يراه الجميع، وكل مستخدم يرى النتائج المسموح له بها فقط.</p>
        </form>
        {err && <div className="text-xs text-(--status-danger) my-2" role="alert">{err.message}</div>}
        {list.isLoading && <div className="inf-skeleton" style={{ height: 120 }} />}
        {list.data && !list.data.items.length && <div className="inf-state">لا توجد عمليات بحث محفوظة بعد.</div>}
        <ul className="as-saved-list">
          {list.data?.items.map((s) => (
            <li key={s.id} className="as-saved-item">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {editing === s.id
                    ? <form onSubmit={(e) => { e.preventDefault(); patch.mutate({ id: s.id, body: { name: newName } }); }} className="flex gap-1">
                        <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={120} autoFocus aria-label="الاسم الجديد" />
                        <Button variant="ghost" type="submit">حفظ</Button></form>
                    : <div className="font-semibold truncate">{s.name}</div>}
                  <code className="as-saved-q" dir="auto">{s.query || '(كل النتائج)'}</code>
                  <div className="as-saved-meta">
                    {SEARCH_ENTITY_LABELS[s.tab]} · {s.visibility === 'shared' ? <><Globe2 size={11} className="inline" /> مشترك</> : <><Lock size={11} className="inline" /> خاص</>}
                    {!s.is_owner && <> · من {s.owner_name}</>}
                    {' · '}{s.last_run_at ? <>آخر تشغيل <DateTime value={s.last_run_at} /> ({s.run_count})</> : 'لم يُشغّل بعد'}
                  </div>
                </div>
              </div>
              <div className="as-saved-actions">
                <Button variant="ghost" type="submit" onClick={() => run.mutate(s.id)}><Play size={14} /> تشغيل</Button>
                <button className="icon-button" title="نسخ الرابط" aria-label="نسخ رابط البحث" onClick={() => copy(s)}><Link2 size={14} /></button>
                {s.is_owner && <>
                  <button className="icon-button" title="إعادة التسمية" aria-label="إعادة تسمية" onClick={() => { setEditing(s.id); setNewName(s.name); }}><Pencil size={14} /></button>
                  <button className="icon-button" title="تحديث الشروط بالبحث الحالي" aria-label="تحديث الشروط بالبحث الحالي"
                    onClick={() => confirmation.request({title:'استبدال شروط البحث المحفوظ',description:`سيتم استبدال تعريف «${s.name}» بالبحث الحالي${s.visibility==='shared'?'؛ سيتأثر المستخدمون الذين يستخدمون التعريف المشترك':''}. لا يتوفر سجل تراجع هنا.`,confirmLabel:'استبدال الشروط',allowed:()=>available&&!!s.is_owner,execute:()=>patch.mutateAsync({id:s.id,body:{query:current.q,tab:current.tab,period:current.period,sort:current.sort||null}})})}><RefreshCw size={14} aria-hidden="true" /></button>
                  <button className="icon-button" title={s.visibility === 'shared' ? 'جعله خاصًا' : 'مشاركته'} aria-label="تبديل المشاركة"
                    onClick={() => confirmation.request({title:'تغيير مشاركة البحث',description:`«${s.name}» سيصبح ${s.visibility==='shared'?'خاصًا بك':'مشتركًا مع المستخدمين؛ يشمل ذلك نص الاستعلام'}. تبقى صلاحيات النتائج مطبقة.`,confirmLabel:'تغيير المشاركة',allowed:()=>available&&!!s.is_owner,execute:()=>patch.mutateAsync({id:s.id,body:{visibility:s.visibility==='shared'?'private':'shared'}})})}>{s.visibility === 'shared' ? <Lock size={14} /> : <Globe2 size={14} />}</button>
                  <button className="icon-button" title="حذف" aria-label="حذف البحث المحفوظ" onClick={() => confirmation.request({title:'حذف البحث المحفوظ',description:`سيتم حذف تعريف «${s.name}». لن تُحذف نتائج البحث الأصلية. لا يتوفر تراجع هنا.`,confirmLabel:'حذف البحث',danger:true,allowed:()=>available&&!!s.is_owner,execute:()=>remove.mutateAsync(s.id)})}><Trash2 size={14} /></button>
                </>}
              </div>
            </li>
          ))}
        </ul>
      </>}
    </div>
  );
}
