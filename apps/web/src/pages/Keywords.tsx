import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtPct, fmtNum } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';

interface Program { id: string; name_ar: string; color: string }
interface Group { id: string; name_ar: string; type: string; program_name: string; keyword_count: number }
interface Keyword {
  id: string; term: string; type: string; match_mode: string; group_name: string;
  program_name: string; alias_count: number; match_count: number; noise_rate: string | null;
}

const TYPE_META: Record<string, { label: string; cls: string; hint: string }> = {
  primary:   { label: 'أساسية',  cls: 'bg-brand-500/15 text-brand-600 dark:text-brand-400', hint: 'اسم البرنامج ومشتقاته' },
  service:   { label: 'خدمات',   cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-400', hint: 'أسماء الخدمات والعبارات الفعلية للجمهور' },
  related:   { label: 'مرتبطة',  cls: 'bg-teal-500/15 text-teal-600 dark:text-teal-400', hint: 'مصطلحات السياق' },
  negative:  { label: 'مستبعدة', cls: 'bg-red-500/15 text-red-600 dark:text-red-400', hint: 'أرخص أداة لخفض التكلفة — كل نتيجة غير مرتبطة حصة محروقة' },
  sensitive: { label: 'حساسة',   cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', hint: 'ترفع درجة الخطورة عند ظهورها' },
};

export default function Keywords() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [programId, setProgramId] = useState<string>('');
  const [type, setType] = useState<string>('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState<Group | null>(null);
  const [term, setTerm] = useState('');

  const { data: programs } = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });
  const { data: groups } = useQuery({
    queryKey: ['keyword-groups', programId],
    queryFn: () => api.get<{ items: Group[] }>(`/keyword-groups${programId ? `?programId=${programId}` : ''}`),
  });
  const { data: keywords } = useQuery({
    queryKey: ['keywords', programId, type, search],
    queryFn: () => {
      const p = new URLSearchParams();
      if (programId) p.set('programId', programId);
      if (type) p.set('type', type);
      if (search) p.set('q', search);
      return api.get<{ items: Keyword[] }>(`/keywords?${p}`);
    },
  });

  const add = useMutation({
    mutationFn: () => api.post('/keywords', { groupId: adding!.id, term }),
    onSuccess: () => { setTerm(''); setAdding(null); qc.invalidateQueries(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/keywords/${id}`),
    onSuccess: () => qc.invalidateQueries(),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">قاموس الكلمات</h1>
        <p className="text-sm muted">
          الكلمات تُعدَّل من هنا بلا لمس الكود. تعديل مجموعة يُحدِّث كل استعلام يستخدمها تلقائياً.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className="input max-w-48" value={programId} onChange={(e) => setProgramId(e.target.value)}>
          <option value="">كل البرامج</option>
          {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
        </select>
        <select className="input max-w-40" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">كل الأنواع</option>
          {Object.entries(TYPE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <input className="input max-w-64" placeholder="بحث…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {(groups?.items ?? []).map((g) => {
          const meta = TYPE_META[g.type] ?? TYPE_META.related;
          const items = (keywords?.items ?? []).filter((k) => k.group_name === g.name_ar);
          return (
            <div key={g.id} className="card p-4">
              <div className="flex items-start justify-between mb-1">
                <div>
                  <div className="font-semibold text-sm">{g.name_ar}</div>
                  <div className="text-xs muted">{g.program_name}</div>
                </div>
                <span className={`badge ${meta.cls}`}>{meta.label}</span>
              </div>
              <p className="text-xs muted mb-3">{meta.hint}</p>

              <div className="flex flex-wrap gap-1.5 mb-3 min-h-8">
                {items.map((k) => {
                  const noise = k.noise_rate === null ? null : Number(k.noise_rate);
                  const noisy = noise !== null && noise > 0.5;
                  return (
                    <span
                      key={k.id}
                      className={`badge group ${noisy ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'bg-[var(--surface-3)]'}`}
                      title={
                        k.match_count > 0
                          ? `طابق ${k.match_count} — ضجيج ${fmtPct(noise)}`
                          : 'لم يُقاس بعد'
                      }
                    >
                      {k.term}
                      {noisy && <span className="num text-[10px]">{fmtPct(noise)}</span>}
                      {k.alias_count > 0 && <span className="num text-[10px] opacity-60">+{k.alias_count}</span>}
                      {can(PERMISSIONS.KEYWORDS_WRITE) && (
                        <button
                          className="opacity-0 group-hover:opacity-100 transition hover:text-red-600"
                          onClick={() => remove.mutate(k.id)}
                          title="حذف"
                        >×</button>
                      )}
                    </span>
                  );
                })}
                {items.length === 0 && <span className="text-xs muted">لا توجد كلمات</span>}
              </div>

              {can(PERMISSIONS.KEYWORDS_WRITE) && (
                <button className="btn-ghost w-full !py-1.5 !text-xs" onClick={() => setAdding(g)}>+ إضافة كلمة</button>
              )}
            </div>
          );
        })}
      </div>

      {adding && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setAdding(null)}>
          <form
            className="card p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); if (term.trim()) add.mutate(); }}
          >
            <h3 className="font-bold mb-1">إضافة كلمة — {adding.name_ar}</h3>
            <p className="text-xs muted mb-4">
              العبارات متعددة الكلمات تُحوَّل تلقائياً إلى عبارة دقيقة (phrase) في الاستعلام.
            </p>
            <input className="input mb-4" value={term} onChange={(e) => setTerm(e.target.value)}
                   placeholder="مثال: العقد ما يتوثق" autoFocus />
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setAdding(null)}>إلغاء</button>
              <button className="btn-primary" disabled={!term.trim() || add.isPending}>إضافة</button>
            </div>
            {add.error && <div className="text-xs text-red-600 mt-3">{(add.error as Error).message}</div>}
          </form>
        </div>
      )}
    </div>
  );
}
