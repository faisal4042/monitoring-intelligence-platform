import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCircle2, Phone, Plus, ShieldCheck, ShieldOff, SlidersHorizontal, Trash2, UserX, X as Close } from 'lucide-react';
import { normalizeE164, ROLE_LABELS, WHATSAPP_EVENTS, WHATSAPP_PERMISSIONS as W, type RoleKey } from '@mip/shared';
import { api, type ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import AsyncState from '../AsyncState';
import ModalSurface, { ModalCloseButton } from '../ModalSurface';
import { useConfirmAction } from '../ConfirmAction';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { OverflowMenu } from '../ui/OverflowMenu';
import { AUDIENCE_LABELS, OPT_IN_LABEL, type WaAccess, type WaRecipient, type WaRoute } from './types';

interface Candidate { id: string; full_name: string; email: string; role_name_ar: string }
interface Sub { eventType: string; label: string; optional: boolean; enabled: boolean }

/** Recipients are platform employees only, each with recorded consent; routing decides who gets which alert. */
export default function RecipientsSection({ access }: { access: WaAccess }) {
  const qc = useQueryClient();
  const confirmation = useConfirmAction();
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-recipients'] });
  const list = useQuery({ queryKey: ['wa-recipients'], queryFn: () => api.get<{ items: WaRecipient[] }>('/whatsapp/recipients') });
  const [adding, setAdding] = useState(false);
  const [optInFor, setOptInFor] = useState<WaRecipient | null>(null);
  const [phoneFor, setPhoneFor] = useState<WaRecipient | null>(null);
  const [subsFor, setSubsFor] = useState<WaRecipient | null>(null);
  const patch = useMutation({ mutationFn: (v: { id: string; body: object }) => api.patch(`/whatsapp/recipients/${v.id}`, v.body), onSuccess: refresh });
  const optOut = useMutation({ mutationFn: (id: string) => api.post(`/whatsapp/recipients/${id}/opt-out`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/whatsapp/recipients/${id}`), onSuccess: refresh });
  const error = patch.error ?? optOut.error ?? remove.error;

  return (
    <div className="space-y-4">
      {confirmation.dialog}
      <section className="card wa-section" aria-labelledby="wa-rec-h">
        <div className="wa-section-head">
          <div><h2 id="wa-rec-h">المستلمون</h2>
            <p>موظفو المنصة فقط، ولكلٍّ رقم بصيغة دولية وموافقة مسجّلة. لا تُستخرج أرقام من بيانات العملاء أو التفاعلات.</p></div>
          <Button variant="primary" icon={<Plus size={16} aria-hidden="true" />} onClick={() => setAdding(true)}>إضافة مستلم</Button>
        </div>
        {error && <p className="text-xs text-(--status-danger)" role="alert">{(error as ApiError).message}</p>}
        <AsyncState loading={list.isLoading} error={list.error} onRetry={() => list.refetch()} empty={!list.data?.items.length}
          emptyMessage="لا يوجد مستلمون بعد. أضف موظفًا وسجّل موافقته على استقبال الرسائل.">
          <div className="wa-table-wrap">
            <table className="wa-table">
              <thead><tr><th>الموظف</th><th>الرقم</th><th>الموافقة</th><th>الصفة</th><th>الحالة</th><th><span className="sr-only">إجراءات</span></th></tr></thead>
              <tbody>
                {(list.data?.items ?? []).map((r) => {
                  const consent = OPT_IN_LABEL[r.opt_in_status];
                  return (
                    <tr key={r.id}>
                      <td><div>{r.full_name}</div><div className="text-xs muted">{r.role_name_ar}</div></td>
                      <td><bdi dir="ltr" className="num">{r.countryCode} {r.phone}</bdi></td>
                      <td><Badge tone={consent.tone}>{consent.label}</Badge>
                        {r.opt_in_status === 'opted_in' && r.opt_in_at && <div className="text-xs muted mt-1" title={r.opt_in_method ?? undefined}>{fmtDateTime(r.opt_in_at)}</div>}
                        {r.opt_in_status === 'opted_out' && r.opt_out_source && <div className="text-xs muted mt-1">{r.opt_out_source === 'webhook' ? 'برسالة إيقاف عبر واتساب' : r.opt_out_source === 'self' ? 'بنفسه من المنصة' : 'من الإدارة'}</div>}</td>
                      <td>{r.is_supervisor ? <Badge tone="accent">مشرف</Badge> : <span className="muted">موظف</span>}</td>
                      <td>{!r.user_active ? <Badge tone="neutral">حساب غير نشط</Badge> : r.is_active ? <Badge tone="success">نشط</Badge> : <Badge tone="neutral">معطّل</Badge>}
                        {r.disabled_alerts > 0 && <div className="text-xs muted mt-1">أوقف {r.disabled_alerts} تنبيهًا اختياريًا</div>}</td>
                      <td className="text-end">
                        <OverflowMenu label="إجراءات" items={[
                          ...(r.opt_in_status !== 'opted_in' ? [{ key: 'optin', label: 'تسجيل الموافقة', icon: <CheckCircle2 size={16} />, onSelect: () => setOptInFor(r) }] : []),
                          ...(r.opt_in_status === 'opted_in' ? [{ key: 'optout', label: 'إلغاء الاشتراك', icon: <BellOff size={16} />, onSelect: () => confirmation.request({
                            title: 'إلغاء اشتراك المستلم', description: `لن تصل رسائل واتساب إلى «${r.full_name}» حتى تُسجَّل موافقة جديدة، وتُلغى رسائله المنتظرة.`,
                            confirmLabel: 'إلغاء الاشتراك', danger: true, allowed: (can) => can(W.RECIPIENTS), execute: () => optOut.mutateAsync(r.id) }) }] : []),
                          { key: 'subs', label: 'التنبيهات التي يستقبلها', icon: <SlidersHorizontal size={16} />, onSelect: () => setSubsFor(r) },
                          { key: 'phone', label: 'تغيير الرقم', icon: <Phone size={16} />, onSelect: () => setPhoneFor(r) },
                          { key: 'sup', label: r.is_supervisor ? 'إزالة صفة المشرف' : 'تحديد كمشرف', icon: r.is_supervisor ? <ShieldOff size={16} /> : <ShieldCheck size={16} />, onSelect: () => patch.mutate({ id: r.id, body: { isSupervisor: !r.is_supervisor } }) },
                          { key: 'active', label: r.is_active ? 'تعطيل المستلم' : 'إعادة التفعيل', icon: <UserX size={16} />, onSelect: () => patch.mutate({ id: r.id, body: { isActive: !r.is_active } }) },
                          { key: 'del', label: 'حذف', icon: <Trash2 size={16} />, tone: 'danger' as const, onSelect: () => confirmation.request({
                            title: 'حذف المستلم', description: 'إن كان له سجل رسائل يُعطَّل بدل الحذف ليبقى السجل كاملًا.', confirmLabel: 'حذف', danger: true,
                            allowed: (can) => can(W.RECIPIENTS), execute: () => remove.mutateAsync(r.id) }) },
                        ]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </AsyncState>
      </section>
      <RoutesCard access={access} recipients={list.data?.items ?? []} />
      {adding && <AddRecipientDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); refresh(); }} />}
      {optInFor && <OptInDialog recipient={optInFor} onClose={() => setOptInFor(null)} onDone={() => { setOptInFor(null); refresh(); }} />}
      {phoneFor && <PhoneDialog recipient={phoneFor} onClose={() => setPhoneFor(null)} onDone={() => { setPhoneFor(null); refresh(); }} />}
      {subsFor && <SubscriptionsDialog recipient={subsFor} onClose={() => setSubsFor(null)} onDone={() => { setSubsFor(null); refresh(); }} />}
    </div>
  );
}

function AddRecipientDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState('');
  const [phone, setPhone] = useState('');
  const [supervisor, setSupervisor] = useState(false);
  const [consent, setConsent] = useState(false);
  const [method, setMethod] = useState('');
  const candidates = useQuery({ queryKey: ['wa-candidates', q], queryFn: () => api.get<{ items: Candidate[] }>(`/whatsapp/recipients/candidates?q=${encodeURIComponent(q)}`) });
  const save = useMutation({ mutationFn: () => api.post('/whatsapp/recipients', { userId, phone, isSupervisor: supervisor, optIn: consent ? { method } : null }), onSuccess: onDone });
  const normalized = phone ? normalizeE164(phone) : null;
  const submit = (e: FormEvent) => { e.preventDefault(); if (userId && normalized && (!consent || method.trim().length >= 3)) save.mutate(); };
  return (
    <ModalSurface as="form" label="إضافة مستلم واتساب" onClose={onClose} busy={save.isPending} onSubmit={submit} panelClassName="card modal-card p-5 w-full max-w-lg">
      <div className="flex items-center justify-between mb-4"><h2 className="text-lg">إضافة مستلم واتساب</h2>
        <ModalCloseButton className="icon-button" aria-label="إغلاق" onClick={onClose}><Close size={18} /></ModalCloseButton></div>
      <label className="block mb-3"><span className="block text-sm mb-1">ابحث عن موظف</span>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="الاسم أو البريد" autoFocus data-dialog-initial-focus /></label>
      <label className="block mb-3"><span className="block text-sm mb-1">الموظف</span>
        <select className="input" required value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">اختر موظفًا</option>
          {(candidates.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.full_name} — {c.role_name_ar}</option>)}
        </select></label>
      <label className="block mb-1"><span className="block text-sm mb-1">رقم واتساب بالصيغة الدولية</span>
        <input className="input" required dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+9665XXXXXXXX" /></label>
      <p className={`text-xs mb-3 ${phone && !normalized ? 'text-(--status-danger)' : 'muted'}`}>{phone && !normalized ? 'صيغة غير صالحة: يلزم رمز الدولة، مثل ‎+966' : normalized ? <>سيُحفظ: <bdi dir="ltr">{normalized}</bdi></> : 'يُحفظ الرقم مشفّرًا، ويظهر في المنصة بآخر أربعة أرقام فقط.'}</p>
      <label className="flex items-center gap-2 mb-3 text-sm"><input type="checkbox" checked={supervisor} onChange={(e) => setSupervisor(e.target.checked)} /> مشرف (يستقبل تنبيهات المشرفين)</label>
      <label className="flex items-center gap-2 mb-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> لدي موافقة موثّقة من الموظف على استقبال رسائل واتساب</label>
      {consent && <label className="block mb-3"><span className="block text-sm mb-1">طريقة توثيق الموافقة</span>
        <input className="input" required minLength={3} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="مثلاً: نموذج موافقة موقّع بتاريخ …" /></label>}
      {!consent && <p className="text-xs muted mb-3">بدون موافقة يبقى المستلم «بانتظار الموافقة» ولا تصله أي رسالة. يستطيع الموظف تسجيل موافقته بنفسه من صفحة تنبيهاته.</p>}
      {save.error && <p className="text-xs text-(--status-danger) mb-3" role="alert">{(save.error as ApiError).message}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>إلغاء</Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={!userId || !normalized || (consent && method.trim().length < 3)}>إضافة</Button></div>
    </ModalSurface>
  );
}

function OptInDialog({ recipient, onClose, onDone }: { recipient: WaRecipient; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState('');
  const save = useMutation({ mutationFn: () => api.post(`/whatsapp/recipients/${recipient.id}/opt-in`, { method }), onSuccess: onDone });
  return (
    <ModalSurface as="form" label="تسجيل الموافقة" onClose={onClose} busy={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <h2 className="text-lg mb-1">تسجيل موافقة {recipient.full_name}</h2>
      <p className="text-sm muted mb-4">سجّل الموافقة فقط إذا وافق الموظف فعلًا على استقبال رسائل العمل عبر واتساب على رقمه المنتهي بـ <bdi dir="ltr">{recipient.phone}</bdi>.</p>
      <label className="block mb-3"><span className="block text-sm mb-1">طريقة توثيق الموافقة</span>
        <input className="input" required minLength={3} value={method} onChange={(e) => setMethod(e.target.value)} autoFocus data-dialog-initial-focus /></label>
      {save.error && <p className="text-xs text-(--status-danger) mb-3" role="alert">{(save.error as ApiError).message}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>إلغاء</Button><Button variant="primary" type="submit" loading={save.isPending} disabled={method.trim().length < 3}>تسجيل الموافقة</Button></div>
    </ModalSurface>
  );
}

function PhoneDialog({ recipient, onClose, onDone }: { recipient: WaRecipient; onClose: () => void; onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const normalized = phone ? normalizeE164(phone) : null;
  const save = useMutation({ mutationFn: () => api.patch(`/whatsapp/recipients/${recipient.id}`, { phone }), onSuccess: onDone });
  return (
    <ModalSurface as="form" label="تغيير الرقم" onClose={onClose} busy={save.isPending} onSubmit={(e) => { e.preventDefault(); if (normalized) save.mutate(); }}>
      <h2 className="text-lg mb-1">تغيير رقم {recipient.full_name}</h2>
      <p className="text-sm muted mb-4">الموافقة مرتبطة بالرقم: بعد التغيير يعود المستلم «بانتظار الموافقة» حتى تُسجَّل موافقة جديدة.</p>
      <label className="block mb-1"><span className="block text-sm mb-1">الرقم الجديد بالصيغة الدولية</span>
        <input className="input" required dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus data-dialog-initial-focus /></label>
      <p className={`text-xs mb-3 ${phone && !normalized ? 'text-(--status-danger)' : 'muted'}`}>{phone && !normalized ? 'صيغة غير صالحة: يلزم رمز الدولة' : ' '}</p>
      {save.error && <p className="text-xs text-(--status-danger) mb-3" role="alert">{(save.error as ApiError).message}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>إلغاء</Button><Button variant="primary" type="submit" loading={save.isPending} disabled={!normalized}>حفظ الرقم</Button></div>
    </ModalSurface>
  );
}

export function SubscriptionsDialog({ recipient, onClose, onDone, self = false }: { recipient?: WaRecipient; onClose: () => void; onDone: () => void; self?: boolean }) {
  const path = self ? '/whatsapp/me' : `/whatsapp/recipients/${recipient!.id}/subscriptions`;
  const subs = useQuery({ queryKey: ['wa-subs', path], queryFn: () => api.get<{ items?: Sub[]; subscriptions?: Sub[] }>(path) });
  const items = subs.data?.items ?? subs.data?.subscriptions ?? [];
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const save = useMutation({
    mutationFn: () => api.put(self ? '/whatsapp/me/subscriptions' : `/whatsapp/recipients/${recipient!.id}/subscriptions`,
      { subscriptions: Object.entries(draft).map(([eventType, enabled]) => ({ eventType, enabled })) }),
    onSuccess: onDone,
  });
  return (
    <ModalSurface as="form" label="التنبيهات المستلمة" onClose={onClose} busy={save.isPending} onSubmit={(e) => { e.preventDefault(); save.mutate(); }} panelClassName="card modal-card p-5 w-full max-w-2xl">
      <h2 className="text-lg mb-1">{self ? 'تنبيهاتي على واتساب' : `تنبيهات ${recipient!.full_name}`}</h2>
      <p className="text-sm muted mb-4">التنبيهات التشغيلية الإلزامية لا يمكن إيقافها. يصل التنبيه فقط إذا كان مفعّلًا في إعدادات القناة وموجّهًا لهذا المستلم.</p>
      <AsyncState loading={subs.isLoading} error={subs.error}>
        <div className="wa-subs">
          {items.map((s) => {
            const on = draft[s.eventType] ?? s.enabled;
            return (
              <div key={s.eventType} className="wa-sub">
                <span>{s.label}{!s.optional && <span className="text-xs muted"> · إلزامي</span>}</span>
                <label className="wa-switch"><input type="checkbox" checked={!s.optional ? true : on} disabled={!s.optional} aria-label={s.label}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.eventType]: e.target.checked }))} /><span className="wa-switch-track" aria-hidden="true" /></label>
              </div>
            );
          })}
        </div>
      </AsyncState>
      {save.error && <p className="text-xs text-(--status-danger) mt-3" role="alert">{(save.error as ApiError).message}</p>}
      <div className="flex justify-end gap-2 mt-4"><Button variant="ghost" onClick={onClose}>إلغاء</Button>
        <Button variant="primary" type="submit" loading={save.isPending} disabled={!Object.keys(draft).length}>حفظ</Button></div>
    </ModalSurface>
  );
}

function RoutesCard({ access, recipients }: { access: WaAccess; recipients: WaRecipient[] }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const routes = useQuery({ queryKey: ['wa-routes'], queryFn: () => api.get<{ items: WaRoute[] }>('/whatsapp/routes') });
  const programs = useQuery({ queryKey: ['programs'], queryFn: () => api.get<{ items: Array<{ id: string; name_ar: string }> }>('/programs'), enabled: can('programs:read') });
  const [form, setForm] = useState({ eventType: '', audience: 'supervisors', roleKey: 'admin', programId: '', recipientId: '' });
  const add = useMutation({
    mutationFn: () => api.post('/whatsapp/routes', { eventType: form.eventType, audience: form.audience,
      roleKey: form.audience === 'role' ? form.roleKey : null, programId: form.programId || null, recipientId: form.audience === 'recipient' ? form.recipientId : null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-routes'] }); qc.invalidateQueries({ queryKey: ['wa-events'] }); },
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/whatsapp/routes/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['wa-routes'] }); qc.invalidateQueries({ queryKey: ['wa-events'] }); } });
  const label = (k: string) => WHATSAPP_EVENTS.find((e) => e.key === k)?.label ?? k;
  return (
    <section className="card wa-section" aria-labelledby="wa-routes-h">
      <div><h2 id="wa-routes-h">مسارات التوجيه</h2>
        <p className="text-sm muted mt-1">من يستقبل كل تنبيه. بدون مسار يُستخدم المستلم الافتراضي الظاهر في «أنواع التنبيهات». المسار المقيّد ببرنامج يطبَّق على أحداث ذلك البرنامج فقط.</p></div>
      {access.recipients && (
        <form className="wa-filters" onSubmit={(e) => { e.preventDefault(); if (form.eventType) add.mutate(); }}>
          <select className="input" aria-label="نوع التنبيه" required value={form.eventType} onChange={(e) => setForm({ ...form, eventType: e.target.value })}>
            <option value="">نوع التنبيه</option>
            {WHATSAPP_EVENTS.filter((e) => e.availability !== 'unavailable').map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
          </select>
          <select className="input" aria-label="المستلمون" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })}>
            {Object.entries(AUDIENCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {form.audience === 'role' && <select className="input" aria-label="الدور" value={form.roleKey} onChange={(e) => setForm({ ...form, roleKey: e.target.value })}>
            {(Object.keys(ROLE_LABELS) as RoleKey[]).map((k) => <option key={k} value={k}>{ROLE_LABELS[k].ar}</option>)}</select>}
          {form.audience === 'recipient' && <select className="input" aria-label="المستلم" required value={form.recipientId} onChange={(e) => setForm({ ...form, recipientId: e.target.value })}>
            <option value="">اختر المستلم</option>{recipients.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}</select>}
          <select className="input" aria-label="البرنامج" required={form.audience === 'program_team'} value={form.programId} onChange={(e) => setForm({ ...form, programId: e.target.value })}>
            <option value="">{form.audience === 'program_team' ? 'اختر البرنامج' : 'كل البرامج'}</option>
            {(programs.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
          <Button variant="ghost" type="submit" icon={<Plus size={16} aria-hidden="true" />} loading={add.isPending}>إضافة مسار</Button>
        </form>
      )}
      {(add.error || del.error) && <p className="text-xs text-(--status-danger)" role="alert">{((add.error ?? del.error) as ApiError).message}</p>}
      <AsyncState loading={routes.isLoading} error={routes.error} empty={!routes.data?.items.length} emptyMessage="لا توجد مسارات؛ تُستخدم المستلمات الافتراضية.">
        <div className="wa-table-wrap"><table className="wa-table">
          <thead><tr><th>التنبيه</th><th>المستلمون</th><th>البرنامج</th><th><span className="sr-only">حذف</span></th></tr></thead>
          <tbody>{(routes.data?.items ?? []).map((r) => (
            <tr key={r.id}><td>{label(r.event_type)}</td>
              <td>{AUDIENCE_LABELS[r.audience]}{r.role_name && ` · ${r.role_name}`}{r.recipient_name && ` · ${r.recipient_name}`}</td>
              <td>{r.program_name ?? 'كل البرامج'}</td>
              <td className="text-end">{access.recipients && <Button variant="quiet" size="sm" icon={<Trash2 size={15} aria-hidden="true" />} aria-label={`حذف مسار ${label(r.event_type)}`} onClick={() => del.mutate(r.id)} />}</td></tr>
          ))}</tbody>
        </table></div>
      </AsyncState>
    </section>
  );
}
