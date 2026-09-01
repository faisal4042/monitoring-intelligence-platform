import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtRelative } from '../lib/format';
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UsersRound } from 'lucide-react';

interface UserRow {
  id: string; email: string; full_name: string; is_active: boolean;
  last_login_at: string | null; created_at: string;
  role_key: string; role_name: string; extra_permissions: string[];
}
interface Role { id: string; key: string; name_ar: string; name_en: string; description: string | null; permissions: string[] }

const emptyCreate = { email: '', fullName: '', password: '', roleId: '' };

export default function Users() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [create, setCreate] = useState(emptyCreate);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [editDraft, setEditDraft] = useState({ fullName: '', email: '', roleId: '' });
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [deleting, setDeleting] = useState<UserRow | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ items: UserRow[] }>('/admin/users'),
  });
  const { data: roles } = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<{ items: Role[] }>('/admin/roles'),
  });

  const roleById = (id: string) => roles?.items.find((r) => r.id === id);
  const roleByKey = (key: string) => roles?.items.find((r) => r.key === key);

  const createUser = useMutation({
    mutationFn: () => api.post('/admin/users', create),
    onSuccess: () => { setAdding(false); setCreate(emptyCreate); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });

  const updateUser = useMutation({
    mutationFn: (vars: { id: string; body: Partial<{ fullName: string; email: string; roleId: string; isActive: boolean }> }) =>
      api.patch(`/admin/users/${vars.id}`, vars.body),
    onSuccess: () => { setEditing(null); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });

  const toggleActive = useMutation({
    mutationFn: (vars: { id: string; isActive: boolean }) => api.patch(`/admin/users/${vars.id}`, { isActive: vars.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  const resetPassword = useMutation({
    mutationFn: () => api.post(`/admin/users/${resetting!.id}/reset-password`, { password: newPassword }),
    onSuccess: () => { setResetting(null); setNewPassword(''); },
  });

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.del(`/admin/users/${id}`),
    onSuccess: () => { setDeleting(null); qc.invalidateQueries({ queryKey: ['admin-users'] }); },
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold"><UsersRound size={22} className="text-brand-500" /> إدارة المستخدمين</h1>
          <p className="text-sm muted">الحسابات، الأدوار، وصلاحيات الوصول للمنصة</p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={16} /> مستخدم جديد</button>
      </div>

      {isLoading && <div className="card p-10 text-center muted text-sm">جارٍ التحميل…</div>}

      {!isLoading && (
        <div className="card overflow-hidden">
          <table className="w-full">
            <thead style={{ background: 'var(--surface-2)' }}>
              <tr>
                <th className="th">المستخدم</th>
                <th className="th">الدور</th>
                <th className="th">الحالة</th>
                <th className="th">آخر دخول</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {(users?.items ?? []).map((u) => (
                <tr key={u.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="td">
                    <div className="font-medium">{u.full_name}</div>
                    <div className="text-xs muted">{u.email}</div>
                  </td>
                  <td className="td">
                    <span className="badge bg-brand-500/15 text-brand-600 dark:text-brand-400">
                      {roleByKey(u.role_key)?.key === 'admin' && <ShieldCheck size={12} />} {u.role_name}
                    </span>
                    {u.extra_permissions.length > 0 && (
                      <span className="text-xs muted ms-1.5" title={u.extra_permissions.join('، ')}>+{u.extra_permissions.length} صلاحية إضافية</span>
                    )}
                  </td>
                  <td className="td">
                    <button
                      className={`badge ${u.is_active ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-slate-500/15 text-slate-500'}`}
                      disabled={u.id === me?.id || toggleActive.isPending}
                      onClick={() => toggleActive.mutate({ id: u.id, isActive: !u.is_active })}
                      title={u.id === me?.id ? 'لا يمكنك إيقاف حسابك الخاص' : 'اضغط لتغيير الحالة'}
                    >
                      {u.is_active ? 'نشط' : 'موقوف'}
                    </button>
                  </td>
                  <td className="td text-xs muted">{u.last_login_at ? fmtRelative(u.last_login_at) : 'لم يسجّل دخول بعد'}</td>
                  <td className="td text-end">
                    <div className="flex justify-end gap-1.5">
                      <button
                        className="icon-button !w-8 !h-8"
                        title="تعديل"
                        onClick={() => {
                          setEditing(u);
                          setEditDraft({ fullName: u.full_name, email: u.email, roleId: roleByKey(u.role_key)?.id ?? '' });
                        }}
                      ><Pencil size={14} /></button>
                      <button className="icon-button !w-8 !h-8" title="إعادة تعيين كلمة المرور" onClick={() => setResetting(u)}><KeyRound size={14} /></button>
                      <button
                        className="icon-button !w-8 !h-8 !text-red-600"
                        title={u.id === me?.id ? 'لا يمكنك حذف حسابك الخاص' : 'حذف'}
                        disabled={u.id === me?.id}
                        onClick={() => setDeleting(u)}
                      ><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!users?.items?.length && (
                <tr><td colSpan={5} className="td text-center muted py-8">لا يوجد مستخدمون بعد</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setAdding(false)}>
          <form
            className="card p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); createUser.mutate(); }}
          >
            <h3 className="font-bold mb-4">مستخدم جديد</h3>
            <label className="block text-sm mb-1">الاسم الكامل</label>
            <input className="input mb-3" value={create.fullName} onChange={(e) => setCreate({ ...create, fullName: e.target.value })} required autoFocus />
            <label className="block text-sm mb-1">البريد الإلكتروني</label>
            <input className="input mb-3" type="email" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} required />
            <label className="block text-sm mb-1">كلمة المرور</label>
            <input className="input mb-3" type="password" value={create.password} onChange={(e) => setCreate({ ...create, password: e.target.value })} minLength={8} required />
            <label className="block text-sm mb-1">الدور</label>
            <select className="input mb-4" value={create.roleId} onChange={(e) => setCreate({ ...create, roleId: e.target.value })} required>
              <option value="">اختر دوراً…</option>
              {(roles?.items ?? []).map((r) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
            </select>
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>إلغاء</button>
              <button className="btn-primary" disabled={createUser.isPending}>{createUser.isPending ? 'جارٍ الإنشاء…' : 'إنشاء'}</button>
            </div>
            {createUser.error && <div className="text-xs text-red-600 mt-3">{(createUser.error as ApiError).message}</div>}
          </form>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setEditing(null)}>
          <form
            className="card p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              updateUser.mutate({ id: editing.id, body: editDraft });
            }}
          >
            <h3 className="font-bold mb-4">تعديل — {editing.full_name}</h3>
            <label className="block text-sm mb-1">الاسم الكامل</label>
            <input className="input mb-3" value={editDraft.fullName} onChange={(e) => setEditDraft({ ...editDraft, fullName: e.target.value })} required autoFocus />
            <label className="block text-sm mb-1">البريد الإلكتروني</label>
            <input className="input mb-3" type="email" value={editDraft.email} onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })} required />
            <label className="block text-sm mb-1">الدور</label>
            <select className="input mb-4" value={editDraft.roleId} onChange={(e) => setEditDraft({ ...editDraft, roleId: e.target.value })} required>
              {(roles?.items ?? []).map((r) => <option key={r.id} value={r.id}>{r.name_ar}</option>)}
            </select>
            {roleById(editDraft.roleId) && (
              <p className="text-xs muted mb-4 leading-relaxed">{roleById(editDraft.roleId)?.description}</p>
            )}
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>إلغاء</button>
              <button className="btn-primary" disabled={updateUser.isPending}>{updateUser.isPending ? 'جارٍ الحفظ…' : 'حفظ'}</button>
            </div>
            {updateUser.error && <div className="text-xs text-red-600 mt-3">{(updateUser.error as ApiError).message}</div>}
          </form>
        </div>
      )}

      {resetting && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => { setResetting(null); setNewPassword(''); }}>
          <form
            className="card p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => { e.preventDefault(); resetPassword.mutate(); }}
          >
            <h3 className="font-bold mb-1">إعادة تعيين كلمة المرور</h3>
            <p className="text-xs muted mb-4">لـ {resetting.email}</p>
            <input className="input mb-4" type="password" placeholder="كلمة مرور جديدة" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required autoFocus />
            <div className="flex gap-2 justify-end">
              <button type="button" className="btn-ghost" onClick={() => { setResetting(null); setNewPassword(''); }}>إلغاء</button>
              <button className="btn-primary" disabled={resetPassword.isPending}>{resetPassword.isPending ? 'جارٍ الحفظ…' : 'تعيين'}</button>
            </div>
            {resetPassword.error && <div className="text-xs text-red-600 mt-3">{(resetPassword.error as ApiError).message}</div>}
          </form>
        </div>
      )}

      {deleting && (
        <div className="fixed inset-0 bg-black/50 grid place-items-center z-50 p-4" onClick={() => setDeleting(null)}>
          <div className="card p-5 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold mb-1">حذف {deleting.full_name}؟</h3>
            <p className="text-xs muted mb-4">لن يستطيع الدخول للمنصة بعد الآن. العملية محفوظة في سجل التدقيق.</p>
            {deleteUser.error && <div className="text-xs text-red-600 mb-3">{(deleteUser.error as ApiError).message}</div>}
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" onClick={() => setDeleting(null)}>إلغاء</button>
              <button className="btn-danger" disabled={deleteUser.isPending} onClick={() => deleteUser.mutate(deleting.id)}>
                {deleteUser.isPending ? 'جارٍ الحذف…' : 'حذف'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
