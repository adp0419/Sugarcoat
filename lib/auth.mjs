// Optional Supabase accounts. The browser only talks to this server: sign-in is
// proxied to Supabase Auth, sessions are checked against it, and each person's
// Twinly key is stored AES-256-GCM encrypted in public.profiles (service role only).
// With SUPABASE_URL unset, `enabled` is false and nothing here runs.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from './http.mjs';

const SESSION_CACHE_MS = 60000;
const hash = value => createHash('sha256').update(String(value)).digest('hex');

export function createAuth(config, { fetchImpl = fetch, now = Date.now, logger = console } = {}) {
  const enabled = Boolean(config.supabaseUrl && config.supabaseAnonKey && config.supabaseServiceKey);
  const sessions = new Map();   // sha256(access token) -> { user, expires }
  const profiles = new Map();   // handle -> { id, key, hint }

  // --- Supabase plumbing -----------------------------------------------------
  // New-style keys (sb_publishable_/sb_secret_) go in `apikey` only; legacy JWT keys also as Bearer.
  const keyHeaders = key => ({ apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) });
  async function supabase(path, { method = 'GET', key = config.supabaseAnonKey, headers = {}, body } = {}) {
    let response;
    try {
      response = await fetchImpl(config.supabaseUrl + path, { method, signal: AbortSignal.timeout(10000),
        headers: { ...keyHeaders(key), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new AppError('Could not reach the account service. Try again.', 502, 'AUTH_UNREACHABLE'); }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    return { ok: response.ok, status: response.status, data };
  }
  const service = (path, options = {}) => supabase(path, { ...options, key: config.supabaseServiceKey });
  const handleFor = email => config.callUsers?.[String(email || '').toLowerCase()] || '';

  // --- Twinly key encryption --------------------------------------------------
  function encrypt(plain) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }
  function decrypt(stored) {
    const raw = Buffer.from(stored, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
  function remember(row) {
    let key = '';
    if (row.twinly_key_enc) {
      try { key = decrypt(row.twinly_key_enc); }
      catch { logger.info(JSON.stringify({ auth: 'decrypt', handle: row.handle, outcome: 'failed' })); }
    }
    profiles.set(row.handle, { id: row.id, key, hint: key ? row.twinly_key_hint || '' : '' });
  }

  async function loadProfile(user) {
    const found = await service(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,handle,twinly_key_enc,twinly_key_hint`);
    if (!found.ok) throw new AppError('Could not load your profile.', 502, 'PROFILE_ERROR');
    if (found.data?.[0]) { remember(found.data[0]); return; }
    const made = await service('/rest/v1/profiles', { method: 'POST', body: { id: user.id, handle: user.handle },
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' } });
    if (!made.ok) throw new AppError('Could not create your profile.', 502, 'PROFILE_ERROR');
    remember(made.data?.[0] || { id: user.id, handle: user.handle });
  }

  // Load every stored key at startup so token-link calls can use them too. Best effort.
  async function preload() {
    if (!enabled) return;
    try {
      const all = await service('/rest/v1/profiles?select=id,handle,twinly_key_enc,twinly_key_hint');
      if (all.ok) for (const row of all.data || []) remember(row);
    } catch { /* the first sign-in loads it instead */ }
  }

  // --- sessions ---------------------------------------------------------------
  const tokenOf = (req, url) => {
    const header = /^Bearer\s+(\S+)$/iu.exec(req.headers.authorization || '');
    return header?.[1] || url?.searchParams.get('access_token') || '';
  };

  // The signed-in person for this request, null when it carries no session.
  // Throws 401 for a bad or expired session and 403 for someone not in CALL_USERS.
  async function userFrom(req, url = new URL(req.url, 'http://auth.local')) {
    if (!enabled) return null;
    const token = tokenOf(req, url);
    if (!token) return null;
    const id = hash(token), cached = sessions.get(id);
    if (cached && cached.expires > now()) return cached.user;
    const result = await supabase('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } });
    if (!result.ok || !result.data?.id) throw new AppError('Your session has expired. Sign in again.', 401, 'AUTH_INVALID');
    const user = { id: result.data.id, email: result.data.email, handle: handleFor(result.data.email) };
    if (!user.handle) throw new AppError('This account is not allowed on this server.', 403, 'NOT_ALLOWED');
    if (!profiles.has(user.handle) || profiles.get(user.handle).id !== user.id) await loadProfile(user);
    sessions.set(id, { user, expires: now() + SESSION_CACHE_MS });
    for (const [key, entry] of sessions) if (sessions.size > 200 || entry.expires <= now()) sessions.delete(key);
    return user;
  }
  const twinlyKey = handle => profiles.get(handle)?.key || '';

  // --- chat history -------------------------------------------------------------
  // Cleaned text of Aryan↔Rohit messages and call lines in public.messages. Best
  // effort: a missing table or a failed write never blocks delivery.
  let historyWarned = false;
  const historyFailed = (action, status) => {
    if (historyWarned) return;
    historyWarned = true;
    logger.info(JSON.stringify({ auth: 'history', action, outcome: 'failed', status, hint: 'run the messages table SQL in supabase/schema.sql' }));
  };
  async function saveMessage({ id, from, to, kind, text }) {
    if (!enabled || !text) return;
    try {
      const saved = await service('/rest/v1/messages', { method: 'POST',
        body: { id, from_handle: from, to_handle: to, kind, body: text, created_at: new Date(now()).toISOString() } });
      if (!saved.ok) historyFailed('save', saved.status);
    } catch { historyFailed('save', 0); }
  }
  async function history(a, b, limit = 200) {
    if (!enabled) return [];
    const pair = `in.(${encodeURIComponent(a)},${encodeURIComponent(b)})`;
    try {
      const found = await service(`/rest/v1/messages?from_handle=${pair}&to_handle=${pair}&select=id,from_handle,kind,body,created_at&order=created_at.desc&limit=${limit}`);
      if (!found.ok) { historyFailed('load', found.status); return []; }
      return (found.data || []).reverse().map(row => ({ id: row.id, from: row.from_handle, kind: row.kind, text: row.body, at: row.created_at }));
    } catch { historyFailed('load', 0); return []; }
  }

  // --- Twinly key check ---------------------------------------------------------
  // GET /v1/me is free and needs no scope; it lists the key's scopes.
  async function checkTwinlyKey(key) {
    let response, data = null;
    try {
      response = await fetchImpl(`${config.twinlyBaseUrl.replace(/\/$/u, '')}/me`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
      data = await response.json().catch(() => null);
    } catch { throw new AppError('Could not reach Twinly to check the key. Try again.', 502, 'TWINLY_NETWORK_ERROR'); }
    if (response.status === 401 || response.status === 403) throw new AppError('Twinly rejected this key. Copy it again from Twinly.', 400, 'TWINLY_BAD_KEY');
    if (!response.ok) throw new AppError(`Twinly could not check the key (HTTP ${response.status}).`, 502, 'TWINLY_CHECK_FAILED');
    const scopes = data?.scopes ?? data?.key?.scopes;
    if (Array.isArray(scopes) && !scopes.includes('voice')) {
      throw new AppError('This key is missing the voice scope. Enable it in Twinly, or create a new key with it.', 400, 'TWINLY_SCOPE_MISSING');
    }
  }

  // --- routes ---------------------------------------------------------------------
  const readJson = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > 4096) { req.destroy(); reject(new AppError('Request too large.', 413, 'TOO_LARGE')); } else chunks.push(chunk); });
    req.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new AppError('Send JSON.', 400, 'BAD_JSON')); } });
    req.once('error', reject);
  });
  const sessionOut = (data, handle) => ({ access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(now() / 1000) + (data.expires_in || 3600), handle, email: data.user?.email });
  const authError = data => String(data?.msg || data?.error_description || data?.message || 'Sign-in failed.');

  async function handleAuth(req, res, path, json) {
    if (!path?.startsWith('/api/auth/') && path !== '/api/me' && path !== '/api/me/twinly') return false;
    if (!enabled) { req.resume(); json(404, { error: 'Accounts are not enabled on this server.', code: 'AUTH_DISABLED' }); return true; }
    if (req.headers['sec-fetch-site'] === 'cross-site') { req.resume(); json(403, { error: 'Cross-site request refused.', code: 'BAD_ORIGIN' }); return true; }
    try {
      if (path === '/api/auth/signin' || path === '/api/auth/signup') {
        if (req.method !== 'POST') { req.resume(); json(405, { error: 'Use POST.' }); return true; }
        const { email = '', password = '' } = await readJson(req);
        if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
          json(400, { error: 'Enter your email and password.', code: 'MISSING_FIELDS' }); return true;
        }
        const handle = handleFor(email);
        // Checked before Supabase so strangers can't create accounts here.
        if (!handle) { json(403, { error: 'This email is not allowed on this server.', code: 'NOT_ALLOWED' }); return true; }
        const signup = path === '/api/auth/signup';
        const result = await supabase(signup ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
        if (!result.ok) {
          const wrong = result.data?.error_code === 'invalid_credentials' || result.status === 400 && !signup;
          json(result.status === 429 ? 429 : 400, { error: wrong ? 'Wrong email or password.' : authError(result.data), code: result.data?.error_code || 'AUTH_FAILED' });
          return true;
        }
        if (!result.data?.access_token) { json(200, { confirm: true }); return true; } // email confirmation is on
        await loadProfile({ id: result.data.user.id, handle });
        json(200, sessionOut(result.data, handle)); return true;
      }
      if (path === '/api/auth/refresh') {
        if (req.method !== 'POST') { req.resume(); json(405, { error: 'Use POST.' }); return true; }
        const { refresh_token: refreshToken } = await readJson(req);
        if (typeof refreshToken !== 'string' || !refreshToken) { json(400, { error: 'Missing refresh token.', code: 'MISSING_FIELDS' }); return true; }
        const result = await supabase('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
        const handle = handleFor(result.data?.user?.email);
        if (!result.ok || !result.data?.access_token) { json(401, { error: 'Your session has expired. Sign in again.', code: 'AUTH_INVALID' }); return true; }
        if (!handle) { json(403, { error: 'This account is not allowed on this server.', code: 'NOT_ALLOWED' }); return true; }
        json(200, sessionOut(result.data, handle)); return true;
      }
      if (path === '/api/auth/signout') {
        const token = tokenOf(req);
        req.resume();
        if (token) {
          sessions.delete(hash(token));
          await supabase('/auth/v1/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
        }
        json(200, { ok: true }); return true;
      }

      const user = await userFrom(req);
      if (!user) { req.resume(); json(401, { error: 'Sign in first.', code: 'AUTH_REQUIRED' }); return true; }
      if (path === '/api/me') {
        req.resume();
        json(200, { handle: user.handle, email: user.email, twinly: { hint: profiles.get(user.handle)?.hint || '' } }); return true;
      }
      // /api/me/twinly: PUT {key} saves after checking it with Twinly; DELETE clears it.
      if (req.method === 'PUT') {
        const { key = '' } = await readJson(req);
        if (typeof key !== 'string' || !/^\S{10,200}$/u.test(key.trim())) { json(400, { error: 'Paste the whole Twinly key.', code: 'BAD_KEY' }); return true; }
        const clean = key.trim();
        await checkTwinlyKey(clean);
        const hint = `${clean.slice(0, 9)}…${clean.slice(-4)}`;
        const saved = await service(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH',
          body: { twinly_key_enc: encrypt(clean), twinly_key_hint: hint, updated_at: new Date(now()).toISOString() } });
        if (!saved.ok) throw new AppError('Could not save the key.', 502, 'PROFILE_ERROR');
        profiles.set(user.handle, { id: user.id, key: clean, hint });
        logger.info(JSON.stringify({ auth: 'twinly-key', handle: user.handle, outcome: 'saved' }));
        json(200, { twinly: { hint } }); return true;
      }
      if (req.method === 'DELETE') {
        req.resume();
        const cleared = await service(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH',
          body: { twinly_key_enc: null, twinly_key_hint: null, updated_at: new Date(now()).toISOString() } });
        if (!cleared.ok) throw new AppError('Could not remove the key.', 502, 'PROFILE_ERROR');
        profiles.set(user.handle, { id: user.id, key: '', hint: '' });
        json(200, { twinly: { hint: '' } }); return true;
      }
      req.resume(); res.setHeader('Allow', 'PUT, DELETE'); json(405, { error: 'Use PUT or DELETE.' }); return true;
    } catch (caught) {
      const error = caught instanceof AppError ? caught : new AppError('Account request failed.', 500, 'AUTH_ERROR');
      req.resume(); json(error.status, { error: error.message, code: error.code }); return true;
    }
  }

  return { enabled, userFrom, twinlyKey, preload, handleAuth, encrypt, decrypt, saveMessage, history };
}
