import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { createAuth } from '../lib/auth.mjs';

const quiet = { info() {} };
const SUPABASE = 'https://fake.supabase.co';
const env = {
  SUPABASE_URL: `${SUPABASE}/rest/v1/`, SUPABASE_ANON_KEY: 'sb_publishable_test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), CALL_USERS: 'aryan:aryan@example.com,rohit:rohit@example.com',
};

// In-memory Supabase Auth + PostgREST + Twinly /me, enough for the routes under test.
function fakeBackend() {
  const users = new Map([['aryan@example.com', 'u-aryan'], ['rohit@example.com', 'u-rohit'], ['eve@example.com', 'u-eve']]);
  const rows = new Map(), calls = [];
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const session = email => ({ access_token: `tok:${email}`, refresh_token: `ref:${email}`, expires_in: 3600, user: { id: users.get(email), email } });
  async function fetchImpl(input, init = {}) {
    const url = new URL(String(input)), method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null, auth = init.headers?.Authorization || '';
    calls.push(`${method} ${url.pathname}`);
    if (url.origin === 'https://twinly.test') {
      if (auth === 'Bearer twk_live_goodkey123') return reply(200, { id: 'k1', scopes: ['voice', 'chat'] });
      if (auth === 'Bearer twk_live_noscope123') return reply(200, { id: 'k2', scopes: ['chat'] });
      return reply(401, { error: { code: 'invalid_api_key' } });
    }
    assert.equal(url.origin, SUPABASE);
    if (url.pathname === '/auth/v1/token') {
      const email = (url.searchParams.get('grant_type') === 'refresh_token' ? body.refresh_token.slice(4) : body.email).toLowerCase();
      if (url.searchParams.get('grant_type') === 'password' && body.password !== 'right') return reply(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return reply(200, session(email));
    }
    if (url.pathname === '/auth/v1/user') {
      const email = auth.replace('Bearer tok:', '');
      return users.has(email) ? reply(200, { id: users.get(email), email }) : reply(401, { msg: 'bad jwt' });
    }
    if (url.pathname === '/rest/v1/profiles') {
      assert.equal(init.headers.apikey, 'sb_secret_test');
      const id = url.searchParams.get('id')?.replace('eq.', '');
      if (method === 'GET') return reply(200, id ? (rows.has(id) ? [rows.get(id)] : []) : [...rows.values()]);
      if (method === 'POST') { rows.set(body.id, { ...body }); return reply(201, [rows.get(body.id)]); }
      if (method === 'PATCH') { Object.assign(rows.get(id), body); return reply(204); }
    }
    return reply(404, {});
  }
  return { fetchImpl, rows, calls };
}

async function fixture(t, overrides = {}, dependencies = {}) {
  const backend = fakeBackend();
  const config = { ...readConfig(env), twinlyBaseUrl: 'https://twinly.test/v1', ...overrides };
  const server = await createApp(config, { logger: quiet, fetchImpl: backend.fetchImpl, ...dependencies });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(base + path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const signIn = async email => (await (await post('/api/auth/signin', { email, password: 'right' })).json()).access_token;
  return { base, backend, config, post, signIn };
}

test('config: no SUPABASE_URL keeps accounts off; a pasted /rest/v1/ suffix is trimmed', () => {
  assert.equal(readConfig({}).supabaseUrl, '');
  assert.equal(createAuth(readConfig({})).enabled, false);
  assert.equal(readConfig(env).supabaseUrl, SUPABASE);
  assert.throws(() => readConfig({ ...env, APP_ENCRYPTION_KEY: 'short' }), /APP_ENCRYPTION_KEY/u);
  assert.throws(() => readConfig({ ...env, CALL_USERS: 'mallory:m@x.com' }), /CALL_USERS/u);
});

test('accounts off: auth routes are 404 and /api/config says auth false', async t => {
  const server = await createApp(readConfig({}), { logger: quiet });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/config`)).json()).auth, false);
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 200); // home page unchanged
  const response = await fetch(`${base}/api/auth/signin`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'AUTH_DISABLED');
});

test('sign-in: allowlist checked before Supabase, wrong password, success creates the profile', async t => {
  const { post, backend } = await fixture(t);
  const stranger = await post('/api/auth/signin', { email: 'eve@example.com', password: 'right' });
  assert.equal(stranger.status, 403);
  assert.equal(backend.calls.filter(call => call.includes('/auth/')).length, 0);
  const wrong = await post('/api/auth/signin', { email: 'aryan@example.com', password: 'nope' });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).error, 'Wrong email or password.');
  const ok = await post('/api/auth/signin', { email: 'Aryan@Example.com', password: 'right' });
  const session = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(session.handle, 'aryan');
  assert.ok(session.access_token && session.refresh_token && session.expires_at);
  assert.equal(backend.rows.get('u-aryan').handle, 'aryan');
  const refreshed = await (await post('/api/auth/refresh', { refresh_token: session.refresh_token })).json();
  assert.equal(refreshed.handle, 'aryan');
});

test('/api/process needs a session when accounts are on, and uses that user\'s saved Twinly key', async t => {
  let usedKey;
  const synthesize = async ({ apiKey }) => { usedKey = apiKey; return { format: { encoding: 'encoded', mimeType: 'audio/mpeg' },
    stream: (async function* () { yield Buffer.from('voice'); })() }; };
  const { base, post, signIn } = await fixture(t, { twinlyKey: 'env-shared-key', callKeys: {} }, { synthesize });
  const send = token => fetch(`${base}/api/process`, { method: 'POST', body: Buffer.from('audio'),
    headers: { 'Content-Type': 'audio/webm', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });

  assert.equal((await send()).status, 401);
  assert.equal((await send('tok:nobody@example.com')).status, 401);

  const token = await signIn('aryan@example.com');
  const first = await send(token);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /"type":"done"/u);
  assert.equal(usedKey, 'env-shared-key'); // nothing saved yet: falls back to .env

  assert.equal((await post('/api/me/twinly', {}, token)).status, 405);
  const put = key => fetch(`${base}/api/me/twinly`, { method: 'PUT', body: JSON.stringify({ key }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const noScope = await put('twk_live_noscope123');
  assert.equal(noScope.status, 400);
  assert.equal((await noScope.json()).code, 'TWINLY_SCOPE_MISSING');
  assert.equal((await put('twk_live_badkey1234')).status, 400);
  const saved = await put('twk_live_goodkey123');
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).twinly.hint, 'twk_live_…y123');

  await (await send(token)).text();
  assert.equal(usedKey, 'twk_live_goodkey123');
  const me = await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(me, { handle: 'aryan', email: 'aryan@example.com', twinly: { hint: 'twk_live_…y123' } });
});

test('saved Twinly keys are encrypted at rest and survive a restart', async t => {
  const first = await fixture(t);
  const token = await first.signIn('rohit@example.com');
  await fetch(`${first.base}/api/me/twinly`, { method: 'PUT', body: JSON.stringify({ key: 'twk_live_goodkey123' }),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  const row = first.backend.rows.get('u-rohit');
  assert.ok(row.twinly_key_enc && !row.twinly_key_enc.includes('goodkey'));

  const restarted = createAuth(first.config, { fetchImpl: first.backend.fetchImpl, logger: quiet });
  await restarted.preload();
  assert.equal(restarted.twinlyKey('rohit'), 'twk_live_goodkey123');
  const tampered = Buffer.from(row.twinly_key_enc, 'base64'); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => restarted.decrypt(tampered.toString('base64')));
});

test('call relay: a session names the caller (as= cannot spoof) and works without CALL_TOKEN', async t => {
  const { base, signIn } = await fixture(t, { callToken: '' });
  const token = await signIn('aryan@example.com');
  const poll = await fetch(`${base}/api/call/poll?as=rohit&access_token=${encodeURIComponent(token)}`);
  assert.equal(poll.status, 200);
  assert.equal((await poll.json()).you, 'aryan');
  const noSession = await fetch(`${base}/api/call/poll?as=aryan`);
  assert.equal(noSession.status, 401); // accounts on, no session, no token configured
  assert.equal((await noSession.json()).code, 'AUTH_REQUIRED');
  assert.equal((await fetch(`${base}/api/call/poll?as=aryan&access_token=tok:eve@example.com`)).status, 403);
});

test('home page: accounts on sends / to the comms page and keeps the recorder at /lite', async t => {
  const { base } = await fixture(t);
  const home = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('location'), '/call');
  assert.equal((await fetch(`${base}/lite`)).status, 200);
});

test('call relay: legacy token links still work with accounts on', async t => {
  const { base } = await fixture(t, { callToken: 'legacy' });
  const poll = await fetch(`${base}/api/call/poll?as=rohit&t=legacy`);
  assert.equal(poll.status, 200);
  assert.equal((await poll.json()).you, 'rohit');
});
