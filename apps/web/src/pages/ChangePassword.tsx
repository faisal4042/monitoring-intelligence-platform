import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, LogOut } from 'lucide-react';
import type { AuthUser } from '@mip/shared';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

const MIN_LENGTH = 12;

/**
 * Change your own password. When the account holds a temporary password this
 * is the only screen available (App.tsx routes everything here) until it is
 * replaced — the API enforces the same with PASSWORD_CHANGE_REQUIRED.
 */
export default function ChangePassword() {
  const { user, setSession, logout } = useAuth();
  const navigate = useNavigate();
  const forced = !!user?.mustChangePassword;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < MIN_LENGTH;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm || next.length < MIN_LENGTH) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<{ accessToken: string; user: AuthUser }>('/auth/me/password', {
        currentPassword: current, newPassword: next,
      });
      setSession(r.accessToken, r.user);
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
      if (forced) navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر تغيير كلمة المرور');
    } finally {
      setSaving(false);
    }
  };

  const form = (
    <form className="card w-full max-w-md p-6" onSubmit={submit}>
      <h1 className="mb-1 flex items-center gap-2 text-lg font-bold"><KeyRound size={20} className="text-brand-600" /> تغيير كلمة المرور</h1>
      {forced ? (
        <p className="mb-5 rounded-lg bg-amber-500/10 p-3 text-sm leading-relaxed text-amber-700 dark:text-amber-400" role="status">
          تستخدم كلمة مرور مؤقتة. اختر كلمة مرور جديدة خاصة بك للمتابعة إلى المنصة.
        </p>
      ) : (
        <p className="mb-5 text-sm muted">بعد التغيير ستُغلق جلساتك على الأجهزة الأخرى.</p>
      )}

      <label className="mb-1 block text-sm" htmlFor="cp-current">{forced ? 'كلمة المرور المؤقتة' : 'كلمة المرور الحالية'}</label>
      <input id="cp-current" className="input mb-3" type="password" autoComplete="current-password"
             value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />

      <label className="mb-1 block text-sm" htmlFor="cp-new">كلمة المرور الجديدة</label>
      <input id="cp-new" className="input mb-1" type="password" autoComplete="new-password"
             value={next} onChange={(e) => setNext(e.target.value)} minLength={MIN_LENGTH} required />
      <p className={`mb-3 text-xs ${tooShort ? 'text-red-600' : 'muted'}`}>{MIN_LENGTH} حرفاً على الأقل، ولا تحتوي اسم المستخدم.</p>

      <label className="mb-1 block text-sm" htmlFor="cp-confirm">تأكيد كلمة المرور الجديدة</label>
      <input id="cp-confirm" className="input mb-1" type="password" autoComplete="new-password"
             value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      {mismatch && <p className="mb-2 text-xs text-red-600">كلمتا المرور غير متطابقتين</p>}

      {error && <div className="mt-3 text-sm text-red-600" role="alert">{error}</div>}
      {done && !forced && <div className="mt-3 text-sm text-emerald-600" role="status">تم تغيير كلمة المرور.</div>}

      <div className="mt-5 flex items-center justify-between gap-2">
        {forced ? (
          <button type="button" className="btn-ghost" onClick={() => logout().then(() => navigate('/login'))}>
            <LogOut size={15} /> تسجيل الخروج
          </button>
        ) : <span />}
        <button className="btn-primary" disabled={saving || mismatch || tooShort || !current || !next || !confirm}>
          {saving ? 'جارٍ الحفظ…' : 'حفظ كلمة المرور'}
        </button>
      </div>
    </form>
  );

  // Forced mode renders on its own, outside the app shell.
  return forced
    ? <div className="grid min-h-screen place-items-center p-4">{form}</div>
    : <div className="flex justify-center pt-4">{form}</div>;
}
