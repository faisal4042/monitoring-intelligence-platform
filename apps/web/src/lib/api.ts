/** Typed fetch wrapper. Holds the short-lived access token in memory only. */
let accessToken: string | null = null;
export const setToken = (t: string | null) => { accessToken = t; };
export const getToken = () => accessToken;

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/**
 * Only ever one refresh in flight. Without this, several 401s at once each
 * start their own rotation and all but the first lose the race.
 */
let refreshInFlight: Promise<string | null> | null = null;

export function refreshSession(): Promise<string | null> {
  refreshInFlight ??= fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) return null;
      const data = (await r.json()) as { accessToken: string };
      setToken(data.accessToken);
      return data.accessToken;
    })
    .catch(() => null)
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  // One transparent refresh attempt before surfacing a 401.
  if (res.status === 401 && retry && path !== '/auth/refresh' && path !== '/auth/login') {
    const fresh = await refreshSession();
    if (fresh) return request<T>(path, init, false);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get:   <T>(p: string) => request<T>(p),
  post:  <T>(p: string, body?: unknown) => request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body) }),
  put:   <T>(p: string, body?: unknown) => request<T>(p, { method: 'PUT', body: JSON.stringify(body) }),
  del:   <T>(p: string) => request<T>(p, { method: 'DELETE' }),
};
