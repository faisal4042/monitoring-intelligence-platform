import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtMoney } from '../lib/format';
import type { QueryNode, QueryEstimate } from '@mip/shared';

interface Program { id: string; name_ar: string }
interface Group { id: string; name_ar: string; type: string; program_name: string; keyword_count: number }

type EstimateResponse = QueryEstimate & { compiled: string; estimatedCostPerRun: number; unitPrice: number };

/**
 * Visual builder. The user picks keyword groups and free terms; the AST is
 * assembled here and compiled server-side. Group references stay as references,
 * so later dictionary edits flow through automatically.
 */
export default function QueryBuilder() {
  const navigate = useNavigate();
  const [programId, setProgramId] = useState('');
  const [name, setName] = useState('');
  const [mustGroups, setMustGroups] = useState<string[]>([]);
  const [anyGroups, setAnyGroups] = useState<string[]>([]);
  const [negGroups, setNegGroups] = useState<string[]>([]);
  const [freeTerms, setFreeTerms] = useState('');
  const [excludeRetweets, setExcludeRetweets] = useState(true);
  const [arabicOnly, setArabicOnly] = useState(true);
  const [maxResults, setMaxResults] = useState(50);

  const { data: programs } = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });
  const { data: groups } = useQuery({
    queryKey: ['keyword-groups', programId],
    queryFn: () => api.get<{ items: Group[] }>(`/keyword-groups${programId ? `?programId=${programId}` : ''}`),
    enabled: !!programId,
  });

  useEffect(() => {
    // Sensible defaults: primary terms required, service terms as the OR set,
    // negatives always on. This is the shape that actually yields precision.
    if (!groups?.items) return;
    setMustGroups(groups.items.filter((g) => g.type === 'primary').map((g) => g.id));
    setAnyGroups(groups.items.filter((g) => g.type === 'service').map((g) => g.id));
    setNegGroups(groups.items.filter((g) => g.type === 'negative').map((g) => g.id));
  }, [groups?.items]);

  const ast: QueryNode = useMemo(() => {
    const children: QueryNode[] = [];
    for (const id of mustGroups) children.push({ op: 'KEYWORD_GROUP', groupId: id });
    if (anyGroups.length) {
      children.push({ op: 'OR', children: anyGroups.map((id) => ({ op: 'KEYWORD_GROUP', groupId: id }) as QueryNode) });
    }
    const terms = freeTerms.split(',').map((t) => t.trim()).filter(Boolean);
    if (terms.length) {
      children.push({ op: 'OR', children: terms.map((t) => ({ op: t.includes(' ') ? 'PHRASE' : 'TERM', value: t }) as QueryNode) });
    }
    for (const id of negGroups) children.push({ op: 'KEYWORD_GROUP', groupId: id });
    if (excludeRetweets) children.push({ op: 'NOT', child: { op: 'FILTER', key: 'is:retweet' } });
    if (arabicOnly) children.push({ op: 'FILTER', key: 'lang', value: 'ar' });
    return { op: 'AND', children: children.length ? children : [{ op: 'TERM', value: '' }] };
  }, [mustGroups, anyGroups, negGroups, freeTerms, excludeRetweets, arabicOnly]);

  const [estimate, setEstimate] = useState<EstimateResponse | null>(null);

  useEffect(() => {
    if (!programId) return;
    const t = setTimeout(() => {
      api.post<EstimateResponse>('/queries/estimate', { ast, maxResults })
        .then(setEstimate)
        .catch(() => setEstimate(null));
    }, 350);
    return () => clearTimeout(t);
  }, [ast, maxResults, programId]);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/queries', {
      programId, name, ast, maxResultsPerCall: maxResults, maxPagesPerRun: 1,
    }),
    onSuccess: (q) => navigate(`/queries/${q.id}/test`),
  });

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const breadth = estimate?.breadthScore ?? 0;
  const noise = estimate?.noiseRiskScore ?? 0;

  function Meter({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
    const bad = invert ? value > 55 : value > 65;
    const warn = invert ? value > 35 : value > 45;
    const color = bad ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-emerald-500';
    return (
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="muted">{label}</span>
          <span className="num font-medium">{value.toFixed(0)}/100</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-3)' }}>
          <div className={`h-full ${color} transition-all`} style={{ width: `${value}%` }} />
        </div>
      </div>
    );
  }

  const GroupPicker = ({ title, hint, types, selected, onToggle }: {
    title: string; hint: string; types: string[]; selected: string[]; onToggle: (id: string) => void;
  }) => (
    <div>
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs muted mb-2">{hint}</div>
      <div className="flex flex-wrap gap-1.5">
        {(groups?.items ?? []).filter((g) => types.includes(g.type)).map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onToggle(g.id)}
            className={`badge transition ${
              selected.includes(g.id) ? 'bg-brand-600 text-white' : 'bg-[var(--surface-3)] hover:bg-[var(--border)]'
            }`}
          >
            {g.name_ar} <span className="num opacity-70">{g.keyword_count}</span>
          </button>
        ))}
        {!groups?.items?.length && <span className="text-xs muted">اختر برنامجاً أولاً</span>}
      </div>
    </div>
  );

  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <h1 className="text-xl font-bold">بناء استعلام</h1>
        <p className="text-sm muted">
          التقدير أدناه مجاني تماماً — لا يُرسل أي طلب إلى X. الاختبار الفعلي يأتي في الخطوة التالية.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-5 space-y-4">
          <div>
            <label className="block text-sm mb-1">البرنامج</label>
            <select className="input" value={programId} onChange={(e) => setProgramId(e.target.value)}>
              <option value="">اختر برنامجاً…</option>
              {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm mb-1">اسم الاستعلام</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)}
                   placeholder="مثال: إيجار — مشاكل التوثيق" />
          </div>

          <GroupPicker title="يجب أن يحتوي (AND)" hint="كل كلمات هذه المجموعات شرط أساسي — هذا ما يضيّق النطاق"
                       types={['primary']} selected={mustGroups} onToggle={(id) => toggle(mustGroups, setMustGroups, id)} />

          <GroupPicker title="وواحدة على الأقل من (OR)" hint="مجموعات الخدمات والمصطلحات المرتبطة"
                       types={['service', 'related']} selected={anyGroups} onToggle={(id) => toggle(anyGroups, setAnyGroups, id)} />

          <GroupPicker title="استبعاد (NOT)" hint="الكلمات السالبة — أرخص وسيلة لخفض التكلفة"
                       types={['negative']} selected={negGroups} onToggle={(id) => toggle(negGroups, setNegGroups, id)} />

          <div>
            <label className="block text-sm mb-1">كلمات إضافية (افصل بفاصلة)</label>
            <input className="input" value={freeTerms} onChange={(e) => setFreeTerms(e.target.value)}
                   placeholder="التوثيق واقف, العقد معلق" />
          </div>

          <div className="flex flex-wrap gap-4 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={excludeRetweets} onChange={(e) => setExcludeRetweets(e.target.checked)} />
              استبعاد إعادات النشر
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={arabicOnly} onChange={(e) => setArabicOnly(e.target.checked)} />
              العربية فقط
            </label>
          </div>

          <div>
            <label className="block text-sm mb-1">أقصى نتائج لكل طلب</label>
            <select className="input" value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value))}>
              {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        <div className="card p-5 space-y-4 h-fit sticky top-0">
          <div>
            <div className="text-sm font-medium mb-2">الاستعلام المُترجَم</div>
            <pre className="text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all num"
                 style={{ background: 'var(--surface-2)', direction: 'ltr', textAlign: 'left' }}>
              {estimate?.compiled || '—'}
            </pre>
            <div className="text-xs muted mt-1 num">{estimate?.compiledLength ?? 0} حرف</div>
          </div>

          <Meter label="درجة الاتساع" value={breadth} />
          <Meter label="خطر الضجيج" value={noise} invert />

          <div className="grid grid-cols-2 gap-3 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            <div>
              <div className="text-xs muted">وحدات متوقعة/تشغيل</div>
              <div className="text-lg font-bold num">{estimate?.estimatedUnitsPerRun ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs muted">تكلفة متوقعة/تشغيل</div>
              <div className="text-lg font-bold num">{estimate ? fmtMoney(estimate.estimatedCostPerRun) : '—'}</div>
            </div>
          </div>

          {estimate?.warnings?.length ? (
            <div className="space-y-2 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
              {estimate.warnings.map((w, i) => (
                <div
                  key={i}
                  className={`text-xs p-2.5 rounded-lg leading-relaxed ${
                    w.severity === 'critical' ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                      : w.severity === 'warning' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
                      : 'bg-brand-500/10 text-brand-700 dark:text-brand-400'
                  }`}
                >
                  {w.messageAr}
                </div>
              ))}
            </div>
          ) : null}

          <button
            className="btn-primary w-full"
            disabled={!programId || !name.trim() || !estimate?.compiled || create.isPending}
            onClick={() => create.mutate()}
          >
            حفظ ثم الانتقال للاختبار
          </button>
          {create.error && <div className="text-xs text-red-600">{(create.error as Error).message}</div>}
          <p className="text-xs muted text-center">
            الاستعلام يُحفظ بحالة «مسودة» ولن يُنفَّذ إطلاقاً قبل اجتياز الاختبار.
          </p>
        </div>
      </div>
    </div>
  );
}
