import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState(import.meta.env.DEV ? 'admin@mip.local' : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذّر تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <form onSubmit={submit} className="card p-8 w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-xl font-bold">منصة الرصد والتحليل الرقمي</h1>
          <p className="text-sm muted mt-1">Monitoring Intelligence Platform</p>
        </div>

        <label className="block text-sm mb-1">البريد الإلكتروني</label>
        <input className="input mb-4" type="email" value={email}
               onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />

        <label className="block text-sm mb-1">كلمة المرور</label>
        <input className="input mb-4" type="password" value={password}
               onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />

        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'جارٍ الدخول…' : 'تسجيل الدخول'}
        </button>

        {import.meta.env.DEV && <div className="mt-5 pt-4 border-t text-xs muted space-y-0.5" style={{ borderColor: 'var(--border)' }}>
          <div className="font-medium mb-1">حسابات التطوير:</div>
          <div className="num">admin@mip.local / Admin@12345</div>
          <div className="num">viewer@mip.local / Viewer@12345</div>
        </div>}
      </form>
    </div>
  );
}
