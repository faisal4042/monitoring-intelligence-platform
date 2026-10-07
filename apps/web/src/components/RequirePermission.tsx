import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';
import { useAuth } from '../lib/auth';

/**
 * Renders the page only when the user holds one of `perm`. This keeps people
 * off pages whose every request would 403 — it is not the security boundary;
 * the API checks every permission itself.
 */
export default function RequirePermission({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth();
  const perms = Array.isArray(perm) ? perm : [perm];
  if (can(...perms)) return <>{children}</>;
  return (
    <div className="card mx-auto mt-10 max-w-md p-8 text-center" role="alert">
      <ShieldOff size={28} className="mx-auto mb-3 text-amber-500" aria-hidden="true" />
      <h1 className="text-lg font-bold">لا تملك صلاحية الوصول لهذه الصفحة</h1>
      <p className="mt-2 text-sm muted">إذا كنت تحتاجها في عملك، تواصل مع مدير النظام.</p>
      <Link to="/" className="btn-ghost mt-5 inline-flex">العودة للرئيسية</Link>
    </div>
  );
}
