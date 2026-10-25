// Session helper for optional accounts (/api/config reports auth: true).
// The server proxies Supabase, so this page never talks to Supabase directly.
const KEY = 'sugarcoat-session';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
function setSession(session) {
  try { session ? localStorage.setItem(KEY, JSON.stringify(session)) : localStorage.removeItem(KEY); } catch {}
}

async function post(path, body, token) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Server returned HTTP ${response.status}.`), { code: data.code, status: response.status });
  return data;
}

// Resolves to the session, or { confirm: true } when Supabase wants an email confirmation first.
export async function signIn(email, password, { create = false } = {}) {
  const data = await post(create ? '/api/auth/signup' : '/api/auth/signin', { email, password });
  if (data.access_token) setSession(data);
  return data;
}

export async function signOut() {
  const session = getSession();
  setSession(null);
  if (session) await post('/api/auth/signout', {}, session.access_token).catch(() => {});
}

// A fresh access token, refreshed a minute before it expires. '' when signed out.
let refreshing;
export async function accessToken() {
  const session = getSession();
  if (!session) return '';
  if (session.expires_at * 1000 - Date.now() > 60000) return session.access_token;
  refreshing ||= post('/api/auth/refresh', { refresh_token: session.refresh_token })
    .then(next => { setSession(next); return next.access_token; })
    .catch(error => { if (error.status === 401 || error.status === 403) setSession(null); return ''; })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function authFetch(url, init = {}) {
  const token = await accessToken();
  return fetch(url, { ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
}
