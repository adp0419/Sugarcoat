// QA (Agent D): security checks against a REAL spawned server process. See docs/QA-CALL.md (SEC-*).
// Sentinel secrets are fake values; the server is started without .env.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TOKEN = 'qa-sec-token-Zx81hQ7vP3mN';
const SECRETS = { TWINLY_API_KEY_ARYAN: 'qa-sec-twinly-aryan-AAAA9911', TWINLY_API_KEY_ROHIT: 'qa-sec-twinly-rohit-BBBB9922',
  TWINLY_API_KEY: 'qa-sec-twinly-shared-CCCC9933', GROQ_API_KEY: 'qa-sec-groq-DDDD9944', GOOGLE_API_KEY: 'qa-sec-google-EEEE9955' };

async function boot(env = {}) {
  const child = spawn('node', ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, APP_MODE: 'mock', TTS_PROVIDER: 'mock', PORT: '0', HOST: '127.0.0.1', ...env } });
  let out = '';
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  const base = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('boot timeout: ' + out)), 8000);
    const poll = setInterval(() => { const m = /Local: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(t); clearInterval(poll); res(m[1]); } }, 25);
    child.on('exit', c => rej(new Error('exited ' + c + ' ' + out)));
  });
  return { base, child, log: () => out, stop: () => child.kill() };
}
const snapshot = dir => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(f => { const s = statSync(`${dir}/${f}`); return `${f}:${s.size}:${s.mtimeMs}`; }).sort() : [];
const audioFiles = () => readdirSync(tmpdir()).filter(f => /\.(webm|wav|mp3|mp4|ogg|m4a|flac|pcm)$/i.test(f));

test('SEC-1/2/3/5/6 a full session leaks no token, no key, no stack, and writes no audio to disk', async t => {
  const s = await boot({ CALL_TOKEN: TOKEN, ...SECRETS }); t.after(() => s.stop());
  const before = { cache: snapshot(root + 'cache'), logs: snapshot(root + 'logs'), tmp: audioFiles() };
  const bodies = [];  // every response head + body we see
  const grab = async (r, label) => { const b = await r.text().catch(() => ''); bodies.push({ label, status: r.status, headers: JSON.stringify([...r.headers]), body: b }); return b; };
  const q = (as, t = TOKEN) => `as=${as}&t=${encodeURIComponent(t)}`;
  const sse = async as => { const ac = new AbortController(); const r = await fetch(`${s.base}/api/call/events?${q(as)}`, { signal: ac.signal });
    const chunks = []; (async () => { try { for await (const c of r.body) chunks.push(Buffer.from(c).toString()); } catch {} })();
    return { stop: () => ac.abort(), text: () => chunks.join(''), headers: JSON.stringify([...r.headers]), status: r.status }; };
  const rohit = await sse('rohit'), aryan = await sse('aryan');
  await delay(200);
  const r = await fetch(`${s.base}/api/call/speak?${q('aryan')}`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(3000, 7) });
  await grab(r, 'speak');
  await delay(1200);
  const ev = rohit.text(); const clipUrl = /"url":"([^"]+)"/.exec(ev)?.[1];
  assert.ok(clipUrl, 'no clip event seen: ' + ev.slice(0, 300));
  await grab(await fetch(`${s.base}${clipUrl}?t=${TOKEN}`), 'clip');
  // error paths
  const errs = [
    [`${s.base}/api/call/events?as=aryan&t=wrong`], [`${s.base}/api/call/events?as=aryan`], [`${s.base}/api/call/events?as=zzz&t=${TOKEN}`],
    [`${s.base}/api/call/clip/..%2f..%2f.env?t=${TOKEN}`], [`${s.base}/api/call/clip/nope?t=${TOKEN}`], [`${s.base}/api/call/nope?as=aryan&t=${TOKEN}`],
    [`${s.base}/api/call/speak?${q('aryan')}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' }],
    [`${s.base}/api/call/speak?${q('aryan')}`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: '' }],
    [`${s.base}/api/call/speak?${q('aryan')}`, { method: 'GET' }],
    [`${s.base}/api/call/ack?${q('rohit')}`, { method: 'POST', body: '{{{' }],
    [`${s.base}/api/config`], [`${s.base}/healthz`], [`${s.base}/call`], [`${s.base}/call.js`], [`${s.base}/call.css`], [`${s.base}/`], [`${s.base}/.env`], [`${s.base}/lib/call.mjs`], [`${s.base}/../.env`],
  ];
  for (const [u, init] of errs) await grab(await fetch(u, init), (init?.method || 'GET') + ' ' + u.replace(s.base, ''));
  aryan.stop(); rohit.stop(); await delay(300);

  const everything = bodies.map(b => b.headers + b.body).join('\n') + rohit.text() + aryan.text() + rohit.headers + aryan.headers;
  for (const [name, value] of Object.entries({ ...SECRETS })) {
    assert.ok(!everything.includes(value), `${name} value appeared in a response`);
    assert.ok(!s.log().includes(value), `${name} value appeared in server output`);
  }
  assert.ok(!everything.includes(TOKEN), 'CALL_TOKEN appeared in a response body/header: ' + bodies.filter(b => (b.headers + b.body).includes(TOKEN)).map(b => b.label));
  assert.ok(!s.log().includes(TOKEN), 'CALL_TOKEN appeared in server logs:\n' + s.log().split('\n').filter(l => l.includes(TOKEN)).join('\n'));
  assert.ok(!/\bat\s+\S+.*:\d+:\d+|node_modules|supabase\.co|googleapis|api\.groq/.test(everything), 'stack trace or provider URL in a response');
  for (const b of bodies) {
    if (b.label.endsWith('/.env') || b.label.includes('/lib/call.mjs') || b.label.includes('../.env')) assert.equal(b.status, 404, b.label + ' should 404, got ' + b.status);
  }
  assert.deepEqual(snapshot(root + 'cache'), before.cache, 'cache/ changed');
  assert.deepEqual(snapshot(root + 'logs'), before.logs, 'logs/ changed');
  assert.deepEqual(audioFiles(), before.tmp, 'audio files appeared in the temp dir');
  console.log('    responses inspected:', bodies.length, '| server log bytes:', s.log().length);
});

test('SEC-7 CALL_TOKEN unset: every call route answers 503, never open', async t => {
  const s = await boot({}); t.after(() => s.stop());
  for (const [method, path] of [['GET', '/api/call/events?as=aryan'], ['GET', '/api/call/events?as=aryan&t='], ['GET', '/api/call/events?as=aryan&t=undefined'],
    ['GET', '/api/call/events?as=aryan&t=null'], ['POST', '/api/call/speak?as=aryan&t='], ['GET', '/api/call/clip/abc?t='], ['POST', '/api/call/ack?as=aryan&t='],
    ['GET', '/api/call/events?as=zzz'], ['GET', '/api/call/nothing']]) {
    const r = await fetch(s.base + path, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'audio/webm' }, body: Buffer.alloc(100) } : {}) });
    assert.equal(r.status, 503, `${method} ${path} -> ${r.status}`); await r.body?.cancel();
  }
});

test('SEC-4 /call is served with a strict CSP and no inline script/style', async t => {
  const s = await boot({ CALL_TOKEN: TOKEN }); t.after(() => s.stop());
  const page = await fetch(s.base + '/call'); const html = await page.text();
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/); assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(csp), 'CSP weakened: ' + csp);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[^<]/i.test(html), 'inline <script> body present');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute present');
  assert.ok(!/<style[\s>]/i.test(html) && !/\sstyle\s*=/i.test(html), 'inline style (blocked by style-src self)');
  assert.ok(!html.includes(TOKEN));
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('permissions-policy') || '', /microphone=\(self\)/);
  for (const [p, type] of [['/call.js', /javascript/], ['/call.css', /css/]]) {
    const r = await fetch(s.base + p); assert.equal(r.status, 200, p); assert.match(r.headers.get('content-type'), type); await r.body?.cancel();
  }
  assert.ok(!html.includes('<script src="https://') && !/(src|href)=["']https?:\/\//i.test(html), 'external resource loaded by /call');
});

test('SEC-9 malformed HTTP and slowloris-ish input do not take the server down', async t => {
  const s = await boot({ CALL_TOKEN: TOKEN }); t.after(() => s.stop());
  const net = await import('node:net');
  for (const raw of ['GET /api/call/events?as=aryan&t=' + 'A'.repeat(70000) + ' HTTP/1.1\r\nHost: x\r\n\r\n', 'POST /api/call/speak HTTP/1.1\r\nHost: x\r\nContent-Length: -5\r\n\r\n',
    'GET /api/call/clip/%ZZ HTTP/1.1\r\nHost: x\r\n\r\n', 'GET /api/call/events?as=%E0%A4%A&t=x HTTP/1.1\r\nHost: x\r\n\r\n']) {
    await new Promise(res => { const c = net.connect(new URL(s.base).port, '127.0.0.1', () => c.write(raw)); c.on('data', () => {}); c.on('error', () => res()); c.on('close', res); setTimeout(() => { c.destroy(); res(); }, 400); });
  }
  const h = await fetch(s.base + '/healthz'); assert.equal(h.status, 200, 'server dead after malformed input'); assert.ok(!s.log().includes('Error'), 'unhandled error in server output: ' + s.log().slice(0, 500));
});
