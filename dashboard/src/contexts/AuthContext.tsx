import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { getAuthHeaders, getStoredAuthToken, getStoredAuthUser } from '../utils/client-runtime';

interface User {
  id?: string;
  username?: string;
  email: string;
  name: string;
  tenantId?: string;
  role?: 'tenant_admin' | 'team_admin' | 'member';
  inputSuggestionModel?: string;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoggedIn: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  register: (name: string, email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  refreshUser: () => Promise<User | null>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function saveJwt(token: string) { localStorage.setItem('agentma_jwt', token); }
function clearApiKey() { localStorage.removeItem('agentma_api_key'); }
function saveUser(user: User) { localStorage.setItem('agentma_user', JSON.stringify(user)); }
function buildAuthUser(data: any, fallback?: Partial<User> | null): User {
  return {
    id: data.id || fallback?.id,
    username: data.username || fallback?.username,
    email: data.email || fallback?.email || '',
    name: data.name || fallback?.name || '',
    tenantId: data.tenantId || fallback?.tenantId,
    role: data.role || fallback?.role,
    inputSuggestionModel: typeof data.inputSuggestionModel === 'string'
      ? data.inputSuggestionModel
      : fallback?.inputSuggestionModel || '',
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    const t = getStoredAuthToken();
    const u = getStoredAuthUser();
    return t && u ? t : null;
  });
  const [user, setUser] = useState<User | null>(() => {
    const t = getStoredAuthToken();
    const u = getStoredAuthUser();
    if (!t || !u) return null;
    return u;
  });

  useEffect(() => {
    if (!token) return;
    if (user?.tenantId && user?.role && user?.inputSuggestionModel !== undefined) return;

    let cancelled = false;
    const hydrate = async () => {
      try {
        const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const nextUser = buildAuthUser(data, user);
        if (cancelled) return;
        saveUser(nextUser);
        setUser(nextUser);
      } catch {}
    };

    void hydrate();
    return () => { cancelled = true; };
  }, [token, user]);

  const refreshUser = useCallback(async () => {
    if (!getStoredAuthToken()) return null;
    try {
      const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
      if (!res.ok) return null;
      const data = await res.json();
      const nextUser = buildAuthUser(data, getStoredAuthUser() || user);
      saveUser(nextUser);
      setUser(nextUser);
      return nextUser;
    } catch {
      return null;
    }
  }, [user]);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || '登录失败' };
      clearApiKey();
      saveJwt(data.token);
      const nextUser = buildAuthUser(data, { email });
      saveUser(nextUser);
      setToken(data.token);
      setUser(nextUser);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error || '注册失败' };
      clearApiKey();
      saveJwt(data.token);
      const nextUser = buildAuthUser(data, { email, name });
      saveUser(nextUser);
      setToken(data.token);
      setUser(nextUser);
      return { ok: true };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('agentma_jwt');
    localStorage.removeItem('agentma_user');
    localStorage.removeItem('agentma_api_key');
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoggedIn: !!token, login, register, refreshUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
