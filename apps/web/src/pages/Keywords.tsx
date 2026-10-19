import { useConfirmAction } from '../components/ConfirmAction';
import { FormField, FieldInput, FieldSelect, FieldTextarea } from '../components/FormField';
import ModalSurface, { ModalCloseButton } from '../components/ModalSurface';
import AsyncState from '../components/AsyncState';
import { useActionNotice } from '../components/ActionNotice';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { keywordsForGroup } from '../lib/keywords';
import { GROUP_TYPES, GROUP_TYPE_LABELS, type GroupType } from '../lib/dictionary';
import { useAuth } from '../lib/auth';
import { fmtPct } from '../lib/format';
import { PERMISSIONS } from '@mip/shared';
import { Pencil, Plus, Power, RotateCcw, Tags, X } from 'lucide-react';

import { Button } from '../components/ui/Button';
interface Program { id: string; name_ar: string; color: string }
interface Group {
  id: string; program_id: string | null; name_ar: string; type: GroupType; description: string | null;
  is_active: boolean; program_name: string; keyword_count: number;
}
interface Keyword {
  id: string; group_id: string; term: string; type: string; match_mode: string; group_name: string;
  program_name: string; alias_count: number; match_count: number; noise_rate: string | null;
  is_active: boolean; weight: string; notes: string | null;
}

const TYPE_META: Record<string, { label: string; cls: string; hint: string }> = {
  primary:   { label: GROUP_TYPE_LABELS.primary,   cls: 'bg-brand-500/15 text-brand-600 dark:text-brand-400', hint: 'اسم البرنامج ومشتقاته' },
  service:   { label: GROUP_TYPE_LABELS.service,   cls: 'bg-(--status-info-soft) text-(--status-info)', hint: 'أسماء الخدمات والعبارات الفعلية للجمهور' },
  related:   { label: GROUP_TYPE_LABELS.related,   cls: 'bg-(--accent-soft) text-(--accent-ink)', hint: 'مصطلحات السياق' },
  negative:  { label: GROUP_TYPE_LABELS.negative,  cls: 'bg-(--status-danger-soft) text-(--status-danger)', hint: 'أرخص أداة لخفض التكلفة — كل نتيجة غير مرتبطة حصة محروقة' },
  sensitive: { label: GROUP_TYPE_LABELS.sensitive, cls: 'bg-(--status-warning-soft) text-(--status-warning)', hint: 'ترفع درجة الخطورة عند ظهورها' },
};

const MATCH_MODES: Array<[string, string]> = [
  ['term', 'كلمة'], ['phrase', 'عبارة دقيقة'], ['hashtag', 'وسم'], ['mention', 'إشارة لحساب'], ['from', 'من حساب'],
];

type GroupDraft = { programId: string; nameAr: string; type: GroupType; description: string };

export default function Keywords() {
  const { can } = useAuth();
  const write = can(PERMISSIONS.KEYWORDS_WRITE);
  const confirmation = useConfirmAction();
  const notice = useActionNotice();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const programId = params.get('programId') ?? '';
  const setProgramId = (value: string) => setParams((old) => {
    const next = new URLSearchParams(old);
    if (value) next.set('programId', value); else next.delete('programId');
    return next;
  }, { replace: true });
  const [type, setType] = useState<string>('');
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [adding, setAdding] = useState<Group | null>(null);
  const [term, setTerm] = useState('');
  const [groupDialog, setGroupDialog] = useState<{ group: Group | null; draft: GroupDraft } | null>(null);
  const [editingKeyword, setEditingKeyword] = useState<Keyword | null>(null);

  const programsRead = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Program[] }>('/programs') });
  const { data: programs } = programsRead;
  const groupsRead = useQuery({
    queryKey: showInactive ? ['keyword-groups', programId, 'inactive'] : ['keyword-groups', programId],
    queryFn: () => {
      const p = new URLSearchParams();
      if (programId) p.set('programId', programId);
      if (showInactive) p.set('includeInactive', '1');
      return api.get<{ items: Group[] }>(`/keyword-groups?${p}`);
    },
  });
  const { data: groups } = groupsRead;
  const keywordsRead = useQuery({
    queryKey: showInactive ? ['keywords', programId, type, search, 'inactive'] : ['keywords', programId, type, search],
    queryFn: () => {
      const p = new URLSearchParams();
      if (programId) p.set('programId', programId);
      if (type) p.set('type', type);
      if (search) p.set('q', search);
      if (showInactive) p.set('includeInactive', '1');
      return api.get<{ items: Keyword[] }>(`/keywords?${p}`);
    },
  });
  const { data: keywords } = keywordsRead;

  const refresh = () => qc.invalidateQueries();
  const add = useMutation({
    mutationFn: () => api.post<Keyword>('/keywords', { groupId: adding!.id, term }),
    onSuccess: (k) => { notice.success(`أُضيفت «${k.term}» إلى «${adding?.name_ar}».`); setTerm(''); setAdding(null); refresh(); },
  });
  const setKeywordActive = (k: Keyword, isActive: boolean) => api.patch(`/keywords/${k.id}`, { isActive })
    .then(() => { notice.success(isActive ? `أُعيد تفعيل «${k.term}».` : `عُطّلت «${k.term}».`); refresh(); });
  const setGroupActive = (g: Group, isActive: boolean) => api.patch(`/keyword-groups/${g.id}`, { isActive })
    .then(() => { notice.success(isActive ? `فُعّلت مجموعة «${g.name_ar}».` : `عُطّلت مجموعة «${g.name_ar}».`); refresh(); });

  const openNewGroup = () => setGroupDialog({
    group: null,
    draft: { programId: programId || programs?.items[0]?.id || '', nameAr: '', type: 'primary', description: '' },
  });
  const openEditGroup = (g: Group) => setGroupDialog({
    group: g, draft: { programId: g.program_id ?? '', nameAr: g.name_ar, type: g.type, description: g.description ?? '' },
  });

  const pageReads = [programsRead, groupsRead, keywordsRead];
  const readError = pageReads.find(read => read.error)?.error;
  const groupItems = groups?.items ?? [];
  const selectedProgram = programs?.items.find((p) => p.id === programId);

  return (
    <div className="space-y-5">
      {confirmation.dialog}
      <div className="page-heading flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5"><Tags size={22} className="text-brand-600" /> قاموس الكلمات</h1>
          <p>الكلمات تُعدَّل من هنا بلا لمس الكود. الاستعلامات التلقائية تُبنى من مجموعات البرنامج النشطة.</p>
        </div>
        {write && <Button variant="primary" type="button" onClick={openNewGroup} disabled={!programs?.items.length}><Plus size={16} /> مجموعة جديدة</Button>}
      </div>
      {notice.element}

      <div className="flex flex-wrap items-center gap-2">
        <FormField label="البرنامج" labelClassName="sr-only" className="max-w-48">
        <FieldSelect className="input max-w-48" value={programId} onChange={(e) => setProgramId(e.target.value)}>
          <option value="">كل البرامج</option>
          {(programs?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
        </FieldSelect></FormField>
        <FormField label="نوع الكلمات" labelClassName="sr-only" className="max-w-40">
        <FieldSelect className="input max-w-40" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">كل الأنواع</option>
          {Object.entries(TYPE_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </FieldSelect></FormField>
        <FormField label="البحث عن كلمة" labelClassName="sr-only" className="max-w-64">
        <FieldInput className="input max-w-64" placeholder="بحث…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </FormField>
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          إظهار المعطّلة
        </label>
      </div>

      <AsyncState loading={pageReads.some(read => read.isLoading)} error={readError}
        onRetry={() => Promise.all(pageReads.map(read => read.refetch()))}>
      {groupItems.length === 0 && (
        <div className="card p-8 text-center space-y-3">
          <p className="muted">{selectedProgram ? `لا توجد مجموعات كلمات لبرنامج «${selectedProgram.name_ar}» بعد.` : 'لا توجد مجموعات كلمات.'}</p>
          {write && <Button variant="primary" type="button" onClick={openNewGroup}><Plus size={16} /> أنشئ أول مجموعة</Button>}
        </div>
      )}
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        {groupItems.map((g) => {
          const meta = TYPE_META[g.type] ?? TYPE_META.related;
          const items = keywordsForGroup(keywords?.items ?? [], g.id);
          return (
            <div key={g.id} className={`card p-4 ${g.is_active ? '' : 'opacity-70'}`}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0">
                  <div className="font-semibold text-sm">{g.name_ar}</div>
                  <div className="text-xs muted">{g.program_name}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {!g.is_active && <span className="badge bg-slate-500/15 text-slate-600 dark:text-slate-300">معطّلة</span>}
                  <span className={`badge ${meta.cls}`}>{meta.label}</span>
                </div>
              </div>
              <p className="text-xs muted mb-3">{g.description || meta.hint}</p>

              <div className="flex flex-wrap gap-1.5 mb-3 min-h-8">
                {items.map((k) => {
                  const noise = k.noise_rate === null ? null : Number(k.noise_rate);
                  const noisy = k.is_active && noise !== null && noise > 0.5;
                  return (
                    <span
                      key={k.id}
                      className={`badge group ${!k.is_active ? 'line-through opacity-60 bg-[var(--surface-3)]' : noisy ? 'bg-(--status-danger-soft) text-(--status-danger)' : 'bg-[var(--surface-3)]'}`}
                      title={!k.is_active ? 'معطّلة' : k.match_count > 0 ? `طابق ${k.match_count} — ضجيج ${fmtPct(noise)}` : 'لم يُقاس بعد'}
                    >
                      {write && k.is_active
                        ? <button type="button" className="hover:underline" onClick={() => setEditingKeyword(k)} title="تعديل الكلمة">{k.term}</button>
                        : k.term}
                      {noisy && <span className="num text-xs">{fmtPct(noise)}</span>}
                      {k.alias_count > 0 && <span className="num text-xs opacity-60">+{k.alias_count}</span>}
                      {write && k.is_active && (
                        <button
                          type="button"
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition hover:text-(--status-danger)"
                          onClick={() => confirmation.request({ title: 'تعطيل كلمة رصد', description: `ستُعطَّل «${k.term}» في «${g.name_ar}» وتُستبعد من الاستعلامات التلقائية عند المزامنة التالية. يمكن إعادة تفعيلها لاحقًا، ولا يُحذف سجلها.`, confirmLabel: 'تعطيل الكلمة', danger: true, allowed: can => can(PERMISSIONS.KEYWORDS_WRITE), execute: () => setKeywordActive(k, false).catch((e) => { notice.error(e); throw e; }) })}
                          title="تعطيل" aria-label={`تعطيل ${k.term}`}
                        ><X size={11} /></button>
                      )}
                      {write && !k.is_active && (
                        <button type="button" className="hover:text-(--status-success)" title="إعادة التفعيل" aria-label={`إعادة تفعيل ${k.term}`}
                          onClick={() => confirmation.request({ title: 'إعادة تفعيل كلمة', description: `ستعود «${k.term}» إلى «${g.name_ar}» وتدخل الاستعلامات التلقائية عند المزامنة التالية.`, confirmLabel: 'إعادة التفعيل', allowed: can => can(PERMISSIONS.KEYWORDS_WRITE), execute: () => setKeywordActive(k, true).catch((e) => { notice.error(e); throw e; }) })}
                        ><RotateCcw size={11} /></button>
                      )}
                    </span>
                  );
                })}
                {items.length === 0 && <span className="text-xs muted">لا توجد كلمات</span>}
              </div>

              {write && (
                <div className="flex gap-2">
                  {g.is_active && <Button variant="ghost" type="button" className="flex-1 !py-1.5 !text-xs" onClick={() => setAdding(g)}><Plus size={13} /> إضافة كلمة</Button>}
                  <Button variant="ghost" type="button" className="!py-1.5 !text-xs" onClick={() => openEditGroup(g)} aria-label={`تعديل مجموعة ${g.name_ar}`}><Pencil size={13} /> تعديل</Button>
                  <Button variant="ghost" type="button" className="!py-1.5 !text-xs" aria-label={`${g.is_active ? 'تعطيل' : 'تفعيل'} مجموعة ${g.name_ar}`}
                    onClick={() => confirmation.request(g.is_active
                      ? { title: 'تعطيل مجموعة', description: `ستُستبعد كلمات «${g.name_ar}» (${g.program_name}) من الاستعلامات التلقائية عند المزامنة التالية. الكلمات نفسها لا تُحذف.`, confirmLabel: 'تعطيل المجموعة', danger: true, allowed: can => can(PERMISSIONS.KEYWORDS_WRITE), execute: () => setGroupActive(g, false).catch((e) => { notice.error(e); throw e; }) }
                      : { title: 'تفعيل مجموعة', description: `ستدخل كلمات «${g.name_ar}» (${g.program_name}) الاستعلامات التلقائية عند المزامنة التالية.`, confirmLabel: 'تفعيل المجموعة', allowed: can => can(PERMISSIONS.KEYWORDS_WRITE), execute: () => setGroupActive(g, true).catch((e) => { notice.error(e); throw e; }) })}>
                    <Power size={13} /> {g.is_active ? 'تعطيل' : 'تفعيل'}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      </AsyncState>

      {adding && (
        <ModalSurface label={'إضافة كلمة'} onClose={() => setAdding(null)} busy={add.isPending} overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-sm" as="form" onSubmit={(e) => { e.preventDefault(); if (term.trim()) add.mutate(); }}>
            <h3 className="font-bold mb-1">إضافة كلمة — {adding.name_ar}</h3>
            <p className="text-xs muted mb-4">
              العبارات متعددة الكلمات تُحوَّل تلقائياً إلى عبارة دقيقة (phrase) في الاستعلام. لا تُقبل كلمة موجودة في المجموعة نفسها بعد توحيد الكتابة.
            </p>
            <FormField label="الكلمة أو العبارة" error={add.error ? (add.error as Error).message : undefined}>
            <FieldInput className="input mb-4" value={term} onChange={(e) => setTerm(e.target.value)}
                   placeholder="مثال: العقد ما يتوثق" autoFocus data-dialog-initial-focus />
            </FormField>
            <div className="flex gap-2 justify-end">
              <ModalCloseButton type="button" className="btn-ghost" onClick={() => setAdding(null)}>إلغاء</ModalCloseButton>
              <Button variant="primary" type="submit" disabled={!term.trim() || add.isPending}>إضافة</Button>
            </div>
          </ModalSurface>
      )}

      {groupDialog && (
        <GroupDialog
          group={groupDialog.group} initial={groupDialog.draft} programs={programs?.items ?? []}
          onClose={() => setGroupDialog(null)}
          onSaved={(text) => { setGroupDialog(null); notice.success(text); refresh(); }}
        />
      )}
      {editingKeyword && (
        <KeywordDialog keyword={editingKeyword} onClose={() => setEditingKeyword(null)}
          onSaved={(text) => { setEditingKeyword(null); notice.success(text); refresh(); }} />
      )}
    </div>
  );
}

function GroupDialog({ group, initial, programs, onClose, onSaved }: {
  group: Group | null; initial: GroupDraft; programs: Program[]; onClose: () => void; onSaved: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const set = <K extends keyof GroupDraft>(key: K, value: GroupDraft[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const save = useMutation({
    mutationFn: () => group
      ? api.patch<Group>(`/keyword-groups/${group.id}`, {
          ...(draft.nameAr.trim() !== group.name_ar ? { nameAr: draft.nameAr.trim() } : {}),
          ...(draft.type !== group.type ? { type: draft.type } : {}),
          ...(draft.description.trim() !== (group.description ?? '') ? { description: draft.description.trim() || null } : {}),
        })
      : api.post<Group>('/keyword-groups', {
          programId: draft.programId, nameAr: draft.nameAr.trim(), type: draft.type,
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
        }),
    onSuccess: (g) => onSaved(group ? `حُفظت تعديلات مجموعة «${g.name_ar}».` : `أُنشئت مجموعة «${g.name_ar}».`),
  });
  const unchanged = !!group && draft.nameAr.trim() === group.name_ar && draft.type === group.type
    && draft.description.trim() === (group.description ?? '');
  const typeChanged = !!group && draft.type !== group.type;
  return (
    <ModalSurface label={group ? 'تعديل مجموعة' : 'مجموعة جديدة'} onClose={onClose} busy={save.isPending}
      overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-md space-y-4"
      as="form" onSubmit={(e) => { e.preventDefault(); if (!save.isPending && !unchanged) save.mutate(); }}>
      <h3 className="font-bold">{group ? `تعديل مجموعة — ${group.name_ar}` : 'مجموعة كلمات جديدة'}</h3>
      <FormField label="البرنامج" required>
        <FieldSelect className="input w-full" value={draft.programId} disabled={!!group} required
          onChange={(e) => set('programId', e.target.value)}>
          <option value="" disabled>اختر البرنامج</option>
          {programs.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
        </FieldSelect>
      </FormField>
      <FormField label="اسم المجموعة" required>
        <FieldInput className="input w-full" required maxLength={120} value={draft.nameAr} onChange={(e) => set('nameAr', e.target.value)}
          placeholder="مثال: الكلمات الأساسية عالية الدقة" autoFocus data-dialog-initial-focus />
      </FormField>
      <FormField label="نوع المجموعة" required description={TYPE_META[draft.type]?.hint}>
        <FieldSelect className="input w-full" value={draft.type} onChange={(e) => set('type', e.target.value as GroupType)}>
          {GROUP_TYPES.map((t) => <option key={t} value={t}>{GROUP_TYPE_LABELS[t]}</option>)}
        </FieldSelect>
      </FormField>
      {typeChanged && <p role="note" className="text-xs text-(--status-warning)">تغيير النوع يغيّر دور كل كلمات المجموعة في الاستعلامات التلقائية عند المزامنة التالية.</p>}
      <FormField label="الوصف (اختياري)">
        <FieldTextarea className="input w-full" rows={2} maxLength={500} value={draft.description} onChange={(e) => set('description', e.target.value)} />
      </FormField>
      {save.error && <p role="alert" className="text-sm text-(--status-danger)">{(save.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <ModalCloseButton type="button" className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton>
        <Button variant="primary" type="submit" disabled={save.isPending || !draft.nameAr.trim() || !draft.programId || unchanged}>
          {save.isPending ? 'جارٍ الحفظ…' : group ? 'حفظ التعديلات' : 'إنشاء المجموعة'}
        </Button>
      </div>
    </ModalSurface>
  );
}

function KeywordDialog({ keyword, onClose, onSaved }: { keyword: Keyword; onClose: () => void; onSaved: (text: string) => void }) {
  const [term, setTerm] = useState(keyword.term);
  const [matchMode, setMatchMode] = useState(keyword.match_mode);
  const [weight, setWeight] = useState(String(Number(keyword.weight)));
  const [notes, setNotes] = useState(keyword.notes ?? '');
  const body = {
    ...(term.trim() !== keyword.term ? { term: term.trim() } : {}),
    ...(matchMode !== keyword.match_mode ? { matchMode } : {}),
    ...(Number(weight) !== Number(keyword.weight) ? { weight: Number(weight) } : {}),
    ...(notes.trim() !== (keyword.notes ?? '') ? { notes: notes.trim() || null } : {}),
  };
  const save = useMutation({
    mutationFn: () => api.patch<Keyword>(`/keywords/${keyword.id}`, body),
    onSuccess: (k) => onSaved(`حُفظت تعديلات «${k.term}».`),
  });
  const validWeight = weight.trim() !== '' && Number(weight) >= 0 && Number(weight) <= 10;
  const unchanged = Object.keys(body).length === 0;
  return (
    <ModalSurface label="تعديل كلمة" onClose={onClose} busy={save.isPending}
      overlayClassName="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" panelClassName="card p-5 w-full max-w-sm space-y-4"
      as="form" onSubmit={(e) => { e.preventDefault(); if (!save.isPending && !unchanged && validWeight && term.trim()) save.mutate(); }}>
      <h3 className="font-bold">تعديل كلمة — {keyword.group_name}</h3>
      <FormField label="الكلمة أو العبارة" required>
        <FieldInput className="input w-full" required maxLength={120} value={term} onChange={(e) => setTerm(e.target.value)} autoFocus data-dialog-initial-focus />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="طريقة المطابقة">
          <FieldSelect className="input w-full" value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
            {MATCH_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </FieldSelect>
        </FormField>
        <FormField label="الوزن" error={validWeight ? undefined : 'بين 0 و10'}>
          <FieldInput className="input w-full num" type="number" min={0} max={10} step={0.1} value={weight} onChange={(e) => setWeight(e.target.value)} dir="ltr" />
        </FormField>
      </div>
      <FormField label="ملاحظات (اختياري)">
        <FieldTextarea className="input w-full" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </FormField>
      {save.error && <p role="alert" className="text-sm text-(--status-danger)">{(save.error as Error).message}</p>}
      <div className="flex gap-2 justify-end">
        <ModalCloseButton type="button" className="btn-ghost" onClick={onClose}>إلغاء</ModalCloseButton>
        <Button variant="primary" type="submit" disabled={save.isPending || unchanged || !validWeight || !term.trim()}>{save.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</Button>
      </div>
    </ModalSurface>
  );
}
