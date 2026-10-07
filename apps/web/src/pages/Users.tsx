import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS } from '@mip/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtRelative } from '../lib/format';
import { AlertTriangle, Check, Copy, KeyRound, Pencil, Plus, Power, ShieldCheck, UserCog, UsersRound } from 'lucide-react';

interface UserRow {
  id: string; email: string; full_name: string; is_active: boolean;
  last_login_at: string | null; created_at: string;
  must_change_password: boolean; disabled_at: string | null; is_locked: boolean;
  role_id: string; role_key: string; role_name: string; extra_permissions: string[];
}
interface Role { id: string; key: string; name_ar: string; name_en: string; description: string | null; permissions: string[] }

/** A one-time secret the API returned: shown once, never stored by the page. */
interface Issued { email: string; password: string; reason: 'create' | 'reset' }

const emptyCreate = { email: '', fullName: '', roleId: '' };

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={onClose}>
      <div className="card p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

function StatusBadge({ u }: { u: UserRow }) {
  if (!u.is_active) return <span className="badge bg-slate-500/15 text-slate-500">معطّل</span>;
  if (u.is_locked) return <span className="badge bg-red-500/15 text-red-600">مقفل مؤقتاً</span>;
  if (u.must_change_password) return <span className="badge bg-amber-500/15 text-amber-600">بانتظار تغيير كلمة المرور</span>;
  return <span className="badge bg-emerald-500/15 text-emerald-600">نشط</span>;
}

export default function Users() {
  const { user: me, can } = useAuth();
  const qc = useQueryClient();
  const canWrite = can(PERMISSIONS.USERS_WRITE);
  const canAssign = can(PERMISSIONS.USERS_ASSIGN_ROLES);

  const [adding, setAdding] = useState(false);
  const [create, setCreate] = useState(emptyCreate);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editDraft, setEditDraft] = useState({ fullName: '', email: '' });
  const [roleFor, setRoleFor] = useState<UserRow | null>(null);
  const [roleDraft, setRoleDraft] = useState('');
  const [toggling, setToggling] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ items: UserRow[] }>('/admin/users'),
  });
  const { data: roles } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<{ items: Role[] }>('/admin/roles'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const roleById = (id: string) => roles?.items.find((r) => r.id === id);
  // Only offer roles the API would let this admin grant (no permission they lack).
  const grantable = (roles?.items ?? []).filter((r) => r.permissions.every((p) => me?.permissions.includes(p)));

  const createUser = useMutation({
    mutationFn: () => api.post<{ user: { email: string }; temporaryPassword: string }>('/admin/users', create),
    onSuccess: (r) => {
      setAdding(false); setCreate(emptyCreate); refresh();
      setIssued({ email: r.user.email, password: r.temporaryPassword, reason: 'create' });
    },
  });
  const updateUser = useMutation({
    mutationFn: (vars: { id: string; body: { fullName: string; email: string } }) => api.patch(`/admin/users/${vars.id}`, vars.body),
    onSuccess: () => { setEditing(null); refresh(); },
  });
  const changeRole = useMutation({
    mutationFn: (vars: { id: string; roleId: string }) => api.put(`/admin/users/${vars.id}/role`, { roleId: vars.roleId }),
    onSuccess: () => { setRoleFor(null); refresh(); },
  });
  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => api.post(`/admin/users/${u.id}/${u.is_active ? 'disable' : 'enable'}`),
    onSuccess: () => { setToggling(null); refresh(); },
  });
  const resetPassword = useMutation({
    mutationFn: (u: UserRow) => api.post<{ temporaryPassword: string }>(`/admin/users/${u.id}/reset-password`),
    onSuccess: (r, u) => { setResetting(null); refresh(); setIssued({ email: u.email, password: r.temporaryPassword, reason: 'reset' }); },
  });

  const closeIssued = () => { setIssued(null); setCopied(false); };
  const copy = async () => {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.password); setCopied(true); } catch { setCopied(false); }
  };
  const err = (e: unknown) => e ? <div className="text-xs text-red-600 mt-3" role="alert">{(e as ApiError).message}</div> : null;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><UsersRound size={22} className="text-brand-500" /> إدارة المستخدمين</h1>
          <p className="text-sm muted">الحسابات والأدوار. لا يُحذف أي حساب — يُعطَّل ويمكن إعادة تفعيله.</p>
        </div>
        {canWrite && canAssign && (
          <button className="btn-primary" onClick={() => { createUser.reset(); setAdding(true); }}><Plus size={16} /> مستخدم جديد</button>
        )}
      </div>

      {isLoading && <div className="card p-10 text-center muted text-sm">جارٍ التحميل…</div>}

      {!isLoading && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">الاسم</th>
                <th className="th">البريد</th>
                <th className="th">الدور</th>
                <th className="th">الحالة</th>
                <th className="th">آخر دخول</th>
                <th className="th">تاريخ الإنشاء</th>
                <th className="th"><span className="sr-only">إجراءات</span></th>
              </tr>
            </thead>
            <tbody>
              {(users?.items ?? []).map((u) => {
                const self = u.id === me?.id;
                return (
                  <tr key={u.id} className="border-t" style={{ borderColor: 'var(--border)', opacity: u.is_active ? 1 : 0.65 }}>
                    <td className="td font-medium">{u.full_name}{self && <span className="text-xs muted"> (أنت)</span>}</td>
                    <td className="td text-sm muted" dir="ltr" style={{ textAlign: 'right' }}>{u.email}</td>
                    <td className="td text-sm">
                      <span className="inline-flex items-center gap-1">
                        {u.role_key === 'admin' && <ShieldCheck size={13} className="text-brand-500" aria-hidden="true" />} {u.role_name}
                      </span>
                      {u.extra_permissions.length > 0 && (
                        <div className="text-[11px] muted" title={u.extra_permissions.join('، ')}>+{u.extra_permissions.length} صلاحية إضافية</div>
                      )}
                    </td>
                    <td className="td"><StatusBadge u={u} /></td>
                    <td className="td text-xs muted" title={u.last_login_at ? fmtDateTime(u.last_login_at) : undefined}>
                      {u.last_login_at ? fmtRelative(u.last_login_at) : 'لم يدخل بعد'}
                    </td>
                    <td className="td text-xs muted">{fmtDateTime(u.created_at)}</td>
                    <td className="td">
                      <div className="flex gap-1 justify-end">
                        {canWrite && (
                          <button className="icon-button !w-8 !h-8" title="تعديل الاسم والبريد" aria-label={`تعديل ${u.full_name}`}
                            onClick={() => { updateUser.reset(); setEditing(u); setEditDraft({ fullName: u.full_name, email: u.email }); }}>
                            <Pencil size={14} />
                          </button>
                        )}
                        {canAssign && (
                          <button className="icon-button !w-8 !h-8" disabled={self}
                            title={self ? 'لا يمكنك تغيير دورك' : 'تغيير الدور'} aria-label={`تغيير دور ${u.full_name}`}
                            onClick={() => { changeRole.reset(); setRoleFor(u); setRoleDraft(u.role_id); }}>
                            <UserCog size={14} />
                          </button>
                        )}
                        {canWrite && (
                          <button className="icon-button !w-8 !h-8" disabled={self}
                            title={self ? 'لا يمكنك إعادة تعيين كلمة مرورك من هنا' : 'إعادة تعيين كلمة المرور'} aria-label={`إعادة تعيين كلمة مرور ${u.full_name}`}
                            onClick={() => { resetPassword.reset(); setResetting(u); }}>
                            <KeyRound size={14} />
                          </button>
                        )}
                        {canWrite && (
                          <button className={`icon-button !w-8 !h-8 ${u.is_active ? '!text-red-600' : '!text-emerald-600'}`} disabled={self}
                            title={self ? 'لا يمكنك تعطيل حسابك' : u.is_active ? 'تعطيل' : 'تفعيل'} aria-label={`${u.is_active ? 'تعطيل' : 'تفعيل'} ${u.full_name}`}
                            onClick={() => { toggleActive.reset(); setToggling(u); }}>
                            <Power size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!users?.items?.length && (
                <tr><td colSpan={7} className="td text-center muted py-8">لا يوجد مستخدمون بعد</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal onClose={() => setAdding(false)}>
          <form onSubmit={(e) => { e.preventDefault(); createUser.mutate(); }}>
            <h3 className="font-bold mb-1">مستخدم جديد</h3>
            <p className="text-xs muted mb-4">يولّد النظام كلمة مرور مؤقتة تظهر لك مرة واحدة، ويُطلب من المستخدم تغييرها عند أول دخول.</p>
            <label className="block text-sm mb-1" htmlFor="nu-name">الاسم الكامل</label>
            <input id="nu-name" className="input mb-3" value={create.fullName} onChange={(e) => setCreate({ ...create, fullName: e.target.value })} required minLength={2} autoFocus />
            <label className="block text-sm mb-1" htmlFor="nu-email">البريد الإلكتروني</label>
            <input id="nu-email" className="input mb-3" type="email" dir="ltr" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} required />
            <label className="block text-sm mb-1" htmlFor="nu-role">الدور</label>
            <select id="nu-role" className="input mb-2" value={create.roleId} onChange={(e) => setCreate({ ...create, roleId: e.target.value })} required>
              <option value="">اختر دوراً…</option>
              {grantable.map((r) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
            </select>
            {roleById(create.roleId) && <p className="text-xs muted mb-2">{roleById(create.roleId)!.permissions.length} صلاحية</p>}
            <div className="flex gap-2 justify-end mt-3">
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>إلغاء</button>
              <button className="btn-primary" disabled={createUser.isPending}>{createUser.isPending ? 'جارٍ الإنشاء…' : 'إنشاء'}</button>
            </div>
            {err(createUser.error)}
          </form>
        </Modal>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)}>
          <form onSubmit={(e) => { e.preventDefault(); updateUser.mutate({ id: editing.id, body: editDraft }); }}>
            <h3 className="font-bold mb-4">تعديل — {editing.full_name}</h3>
            <label className="block text-sm mb-1" htmlFor="eu-name">الاسم الكامل</label>
            <input id="eu-name" className="input mb-3" value={editDraft.fullName} onChange={(e) => setEditDraft({ ...editDraft, fullName: e.target.value })} required minLength={2} autoFocus />
            <label className="block text-sm mb-1" htmlFor="eu-email">البريد الإلكتروني</label>
            <input id="eu-email" className="input mb-4" type="email" dir="ltr" value={editDraft.email} onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })} required />
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>إلغاء</button>
              <button className="btn-primary" disabled={updateUser.isPending}>{updateUser.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            </div>
            {err(updateUser.error)}
          </form>
        </Modal>
      )}

      {roleFor && (
        <Modal onClose={() => setRoleFor(null)}>
          <form onSubmit={(e) => { e.preventDefault(); changeRole.mutate({ id: roleFor.id, roleId: roleDraft }); }}>
            <h3 className="font-bold mb-1">تغيير دور {roleFor.full_name}</h3>
            <p className="text-xs muted mb-4">الدور الحالي: {roleFor.role_name}. يسري التغيير فوراً على كل طلبات المستخدم.</p>
            <select className="input mb-2" value={roleDraft} onChange={(e) => setRoleDraft(e.target.value)} aria-label="الدور الجديد" autoFocus>
              {grantable.map((r) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
            </select>
            {roleById(roleDraft) && <p className="text-xs muted">{roleById(roleDraft)!.permissions.length} صلاحية</p>}
            <div className="flex gap-2 justify-end mt-4">
              <button type="button" className="btn-ghost" onClick={() => setRoleFor(null)}>إلغاء</button>
              <button className="btn-primary" disabled={changeRole.isPending || roleDraft === roleFor.role_id}>
                {changeRole.isPending ? 'جارٍ الحفظ…' : 'تغيير الدور'}
              </button>
            </div>
            {err(changeRole.error)}
          </form>
        </Modal>
      )}

      {toggling && (
        <Modal onClose={() => setToggling(null)}>
          <h3 className="font-bold mb-1">{toggling.is_active ? `تعطيل ${toggling.full_name}؟` : `تفعيل ${toggling.full_name}؟`}</h3>
          <p className="text-xs muted mb-4">
            {toggling.is_active
              ? 'لن يستطيع الدخول، وتُغلق جلساته الحالية فوراً. البيانات تبقى ويمكن إعادة التفعيل لاحقاً.'
              : 'سيستطيع الدخول مجدداً بكلمة مروره الحالية.'}
          </p>
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={() => setToggling(null)}>إلغاء</button>
            <button className={toggling.is_active ? 'btn-danger' : 'btn-primary'} disabled={toggleActive.isPending} onClick={() => toggleActive.mutate(toggling)}>
              {toggleActive.isPending ? 'جارٍ الحفظ…' : toggling.is_active ? 'تعطيل' : 'تفعيل'}
            </button>
          </div>
          {err(toggleActive.error)}
        </Modal>
      )}

      {resetting && (
        <Modal onClose={() => setResetting(null)}>
          <h3 className="font-bold mb-1">إعادة تعيين كلمة مرور {resetting.full_name}؟</h3>
          <p className="text-xs muted mb-4">يولّد النظام كلمة مرور مؤقتة جديدة، وتُغلق كل جلسات المستخدم، ويُطلب منه تغييرها عند الدخول.</p>
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={() => setResetting(null)}>إلغاء</button>
            <button className="btn-primary" disabled={resetPassword.isPending} onClick={() => resetPassword.mutate(resetting)}>
              {resetPassword.isPending ? 'جارٍ التوليد…' : 'إعادة التعيين'}
            </button>
          </div>
          {err(resetPassword.error)}
        </Modal>
      )}

      {issued && (
        <Modal onClose={() => undefined}>
          <h3 className="font-bold mb-1 flex items-center gap-2"><KeyRound size={18} className="text-brand-500" /> كلمة المرور المؤقتة</h3>
          <p className="text-xs muted mb-3">{issued.reason === 'create' ? 'أُنشئ الحساب' : 'أُعيد تعيين كلمة المرور'} لـ <span dir="ltr">{issued.email}</span></p>
          <div className="flex items-center gap-2 rounded-lg p-3 mb-3" style={{ background: 'var(--surface-2)' }}>
            <code className="flex-1 select-all break-all text-sm font-semibold" dir="ltr">{issued.password}</code>
            <button className="icon-button !w-8 !h-8" onClick={copy} title="نسخ" aria-label="نسخ كلمة المرور">
              {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
            </button>
          </div>
          <p className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400" role="alert">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            لن تظهر كلمة المرور هذه مرة أخرى. سلّمها للمستخدم بطريقة آمنة، وسيُطلب منه تغييرها عند أول دخول.
          </p>
          <div className="flex justify-end mt-4">
            <button className="btn-primary" onClick={closeIssued}>تم، أغلق</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
