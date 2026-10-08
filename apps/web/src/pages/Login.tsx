import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { ArrowLeft, Eye, EyeOff, LockKeyhole, Mail, Moon, ShieldCheck, Sun } from 'lucide-react';
import { useTheme } from '../lib/theme';
import BrandLogo from '../components/BrandLogo';

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState(import.meta.env.DEV ? 'admin@mip.local' : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { theme, setTheme } = useTheme();

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
    <div className="login-page">
      <button className="icon-button login-theme" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="تبديل المظهر">
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      {/* Deep Navy identity panel: the negative stacked logo is the guide's default on navy. */}
      <div className="login-visual">
        <div className="login-visual-content">
          <div className="login-logo"><BrandLogo variant="stacked" width={232} /></div>
          <p className="login-product">منصة الرصد <span className="num">MIP</span></p>
          <h2>حوّل ضجيج المشهد الرقمي إلى إشارات واضحة.</h2>
          <p>رصد لحظي، تحليل دقيق، ورؤية موحّدة تساعد فريقك على اتخاذ القرار بثقة.</p>
          <div className="login-trust"><ShieldCheck size={17} aria-hidden="true" /><span>منصة داخلية آمنة من إثراء المتحدة لخدمات الأعمال</span></div>
        </div>
      </div>
      <div className="login-panel">
      <form onSubmit={submit} className="login-form">
        <div className="mb-8">
          <div className="login-mobile-brand"><BrandLogo width={176} /><span className="login-mobile-product">منصة الرصد <span className="num">MIP</span></span></div>
          <p className="eyebrow">مرحبًا بعودتك</p>
          <h1 className="login-title">تسجيل الدخول</h1>
          <p className="text-sm muted mt-2">أدخل بيانات حسابك للوصول إلى لوحة الرصد.</p>
        </div>

        <label className="form-label" htmlFor="email">البريد الإلكتروني</label>
        <div className="input-shell mb-4"><Mail size={17} />
        <input id="email" className="input" type="email" value={email}
               onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </div>

        <label className="form-label" htmlFor="password">كلمة المرور</label>
        <div className="input-shell mb-4"><LockKeyhole size={17} />
        <input id="password" className="input" type={showPassword ? 'text' : 'password'} value={password}
               onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
        </div>

        {error && (
          <div className="form-error mb-4" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? 'جارٍ الدخول…' : <><span>تسجيل الدخول</span><ArrowLeft size={17} /></>}
        </button>

        {import.meta.env.DEV && <div className="mt-5 pt-4 border-t text-xs muted space-y-0.5" style={{ borderColor: 'var(--border)' }}>
          <div className="font-medium mb-1">حسابات التطوير:</div>
          <div className="num">admin@mip.local / Admin@12345</div>
          <div className="num">viewer@mip.local / Viewer@12345</div>
        </div>}
      </form>
      </div>
    </div>
  );
}
