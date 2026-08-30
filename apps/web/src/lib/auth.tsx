import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setToken, refreshSession } from './api';
import type { AuthUser } from '@mip/shared';

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (...perms: string[]) => boolean;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Restore the session from the httpOnly refresh cookie on first load.
    // Goes through the shared helper so StrictMode's double effect does not
    // fire two competing rotations.
    refreshSession()
      .then(async (token) => {
        if (!token) { setUser(null); return; }
        const me = await api.get<{ user: AuthUser }>('/auth/me');
        setUser(me.user);
      })
      .catch(() => { setToken(null); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const d = await api.post<{ accessToken: string; user: AuthUser }>('/auth/login', { email, password });
    setToken(d.accessToken);
    setUser(d.user);
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    setToken(null);
    setUser(null);
  };

  const can = (...perms: string[]) => !!user && perms.some((p) => user.permissions.includes(p));

  return <Ctx.Provider value={{ user, loading, login, logout, can }}>{children}</Ctx.Provider>;
}
