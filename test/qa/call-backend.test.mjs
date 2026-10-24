// QA (Agent D): black-box backend tests for the call relay. See docs/QA-CALL.md (BE-*).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { start, sse, speak, url, fakeProviders, clipText, errorMessage, idOf, LIVE_ENV, TOKEN, AUDIO } from '../../scripts/qa-lib.mjs';

const ROUTES = [
  ['GET', '/api/call/events', true], ['POST', '/api/call/speak', true],
  ['GET', '/api/call/clip/abc123', false], ['POST', '/api/call/ack', true],
];
const req = (app, method, path, opts = {}) => fetch(url(app.base, path, opts), { method, ...(method === 'POST' ? { body: opts.body ?? '{"id":"x"}', headers: { 'Content-Type': opts.type ?? 'application/json' } } : {}) });

test('BE-1 wrong/missing/malformed token -> 401 on every route', async t => {
  const app = await start(); t.after(() => app.close());
  const tokens = [undefined, '', 'wrong', TOKEN.slice(0, -1), TOKEN + 'x', TOKEN + ' ', ' ' + TOKEN, TOKEN.toUpperCase(), 'a'.repeat(5000), '%00', '../..', '😀'];
  for (const [method, path] of ROUTES) for (const tok of tokens) {
    const r = await req(app, method, path, { as: 'aryan', t: tok });
    const body = await r.text();
    assert.equal(r.status, 401, `${method} ${path} t=${String(tok).slice(0, 12)} -> ${r.status}`);
    assert.ok(!body.includes(TOKEN));
  }
  // array-style / duplicated param smuggling must not authenticate
  for (const q of [`t[]=${TOKEN}`, `t=wrong&t=${TOKEN}`, `T=${TOKEN}`, `t%5B%5D=${TOKEN}`]) {
    const r = await fetch(`${app.base}/api/call/events?as=aryan&${q}`);
    assert.equal(r.status, 401, q); await r.body?.cancel();
  }
});

test('BE-2 unknown / malformed name -> 400 (and token is checked first)', async t => {
  const app = await start(); t.after(() => app.close());
  for (const [method, path, needsName] of ROUTES) {
    if (!needsName) continue;
    for (const as of [undefined, '', 'mallory', 'ARYAN ', '__proto__', 'constructor', 'aryan,rohit', 'a'.repeat(500), '../etc']) {
      const r = await req(app, method, path, { as });
      assert.equal(r.status, 400, `${method} ${path} as=${String(as).slice(0, 12)} -> ${r.status}`); await r.body?.cancel();
    }
    const r = await req(app, method, path, { as: 'mallory', t: 'wrong' });
    assert.equal(r.status, 401, 'bad token + bad name must say 401, not reveal names'); await r.body?.cancel();
  }
});

test('BE-3 oversize audio -> 413 (declared and chunked), server survives', async t => {
  const app = await start({ env: { MAX_AUDIO_BYTES: '2048' } }); t.after(() => app.close());
  const rohit = await sse(app, 'rohit');
  const big = await speak(app, 'aryan', { body: Buffer.alloc(5000, 1) });
  assert.equal(big.status, 413);
  // chunked, no content-length
  const status = await new Promise((resolve, reject) => {
    const r = http.request(url(app.base, '/api/call/speak', { as: 'aryan' }), { method: 'POST', headers: { 'Content-Type': 'audio/webm', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', e => resolve('socket:' + e.code));
    for (let i = 0; i < 10; i++) r.write(Buffer.alloc(1000, 2));
    r.end();
  });
  assert.ok([413].includes(status), 'chunked oversize -> ' + status);
  assert.equal((await fetch(app.base + '/healthz')).status, 200);
  assert.ok(!rohit.names().includes('clip'), 'oversize audio must not produce a clip');
});

test('BE-4 empty body -> 400; BE-5 wrong content-type -> 415', async t => {
  const app = await start(); t.after(() => app.close());
  await sse(app, 'rohit');
  assert.equal((await speak(app, 'aryan', { body: Buffer.alloc(0) })).status, 400);
  for (const type of ['text/plain', 'application/json', 'video/mp4', 'application/octet-stream', null]) {
    const r = await speak(app, 'aryan', { type });
    assert.equal(r.status, 415, `content-type ${type} -> ${r.status}`);
  }
});

test('BE-6 clip id guessing and traversal never leak files or stacks', async t => {
  const app = await start(); t.after(() => app.close());
  const ids = ['../../server.mjs', '..%2f..%2fserver.mjs', '%2e%2e%2f%2e%2e%2fserver.mjs', '..\\..\\server.mjs', '%00', 'a'.repeat(10000),
    '0'.repeat(36), '00000000-0000-0000-0000-000000000000-0', '/etc/passwd', '..%252f', '.', '..', '%', 'x%3Fy=1', 'con', '__proto__', 'constructor'];
  for (const id of ids) {
    const r = await fetch(`${app.base}/api/call/clip/${id}?t=${TOKEN}`);
    const body = await r.text();
    assert.ok([400, 404, 414].includes(r.status), `clip/${id.slice(0, 20)} -> ${r.status}`);
    assert.ok(!/import \{|createServer|\/etc\/passwd|root:|\bat .*\.mjs:\d+/.test(body), 'leak: ' + body.slice(0, 120));
  }
  assert.equal((await fetch(`${app.base}/api/call/clip/some-id`)).status, 401, 'clip without token');
});

test('BE-7 clip TTL: a clip fetched after its TTL -> 404 (createCall mounted directly, clipTtlMs=400)', async t => {
  const { createCall } = await import('../../lib/call.mjs');
  const { readConfig } = await import('../../lib/config.mjs');
  const { once } = await import('node:events');
  const config = readConfig({ APP_MODE: 'mock', TTS_PROVIDER: 'mock', CALL_TOKEN: TOKEN });
  const handle = createCall(config, { clipTtlMs: 400, logger: { info() {} } });
  const server = http.createServer(async (rq, rs) => { if (!(await handle(rq, rs, rq.url.split('?')[0]))) { rs.writeHead(404); rs.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const app = { base: `http://127.0.0.1:${server.address().port}`, open: new Set() };
  t.after(() => { for (const c of app.open) c.close(); server.closeAllConnections(); server.close(); });
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  assert.equal((await speak(app, 'aryan')).status, 200);
  const clip = await rohit.next(e => e.event === 'clip');
  assert.equal((await clipText(app, clip)).status, 200, 'fresh clip should be readable');
  await delay(600);
  assert.equal((await clipText(app, clip)).status, 404, 'expired clip still served');
});

test('BE-8 burst of rapid POSTs: 429 at the limit, no crash', async t => {
  const app = await start({ env: { CALL_MAX_LINES: '1000' } }); t.after(() => app.close());
  const rohit = await sse(app, 'rohit');
  const results = await Promise.all(Array.from({ length: 40 }, () => speak(app, 'aryan')));
  const counts = {}; for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  console.log('    burst statuses:', JSON.stringify(counts));
  assert.ok(results.every(r => [200, 429].includes(r.status)), JSON.stringify(counts));
  assert.ok(counts[429] > 0, 'expected some 429 when 40 renders arrive at once: ' + JSON.stringify(counts));
  assert.equal((await fetch(app.base + '/healthz')).status, 200);
  rohit.close();
});

test('BE-9 client disconnect frees its slot (mid-upload, and mid-render)', async t => {
  const app = await start({ env: { MAX_CONCURRENT_REQUESTS: '1' } }); t.after(() => app.close());
  await sse(app, 'rohit');
  // (a) die mid-upload: headers announce 1000 bytes, send 10, then destroy
  await new Promise(resolve => {
    const r = http.request(url(app.base, '/api/call/speak', { as: 'aryan' }), { method: 'POST', headers: { 'Content-Type': 'audio/webm', 'Content-Length': 1000 } });
    r.on('error', () => {}); r.write(Buffer.alloc(10)); setTimeout(() => { r.destroy(); resolve(); }, 100);
  });
  await delay(300);
  const afterUpload = await speak(app, 'aryan');
  assert.equal(afterUpload.status, 200, 'slot leaked after a mid-upload disconnect: got ' + afterUpload.status);
  // (b) abort while the response streams. By design the render outlives the sender, so wait for it to finish.
  const ac = new AbortController();
  const p = speak(app, 'aryan', { signal: ac.signal }).catch(() => 'aborted');
  await delay(100); ac.abort(); await p;
  await delay(2500);
  const afterAbort = await speak(app, 'aryan');
  assert.equal(afterAbort.status, 200, 'slot still held 2.5s after an aborted request: got ' + afterAbort.status);
});

test('BE-10 SSE reconnect gets a fresh hello with the right fields', async t => {
  const app = await start(); t.after(() => app.close());
  const a1 = await sse(app, 'aryan'); const h1 = await a1.next(e => e.event === 'hello');
  assert.deepEqual(Object.keys(h1.data).sort(), ['peer', 'peerOnline', 'you']);
  assert.equal(h1.data.you, 'aryan'); assert.equal(h1.data.peer, 'rohit'); assert.equal(h1.data.peerOnline, false);
  a1.close(); await delay(100);
  const a2 = await sse(app, 'aryan'); const h2 = await a2.next(e => e.event === 'hello');
  assert.equal(h2.data.you, 'aryan');
  const rohit = await sse(app, 'rohit'); const hr = await rohit.next(e => e.event === 'hello');
  assert.equal(hr.data.peerOnline, true);
  const pres = await a2.next(e => e.event === 'presence'); assert.deepEqual({ peer: pres.data.peer, online: pres.data.online }, { peer: 'rohit', online: true });
  assert.equal(a2.res.headers.get('content-type').split(';')[0], 'text/event-stream');
});

test('BE-11 same name connected twice: no crash, presence only drops when the last one closes', async t => {
  const app = await start(); t.after(() => app.close());
  const rohit = await sse(app, 'rohit');
  const a1 = await sse(app, 'aryan'), a2 = await sse(app, 'aryan');
  await a1.next(e => e.event === 'hello'); await a2.next(e => e.event === 'hello');
  await rohit.next(e => e.event === 'presence' && e.data.online === true);
  a1.close(); await delay(300);
  assert.ok(!rohit.events.some(e => e.event === 'presence' && e.data.online === false), 'peer shown offline although a second tab is still connected');
  const r = await speak(app, 'rohit'); assert.equal(r.status, 200);
  await a2.next(e => e.event === 'caption').catch(() => assert.fail('surviving tab did not receive caption'));
  a2.close(); await rohit.next(e => e.event === 'presence' && e.data.online === false);
});

test('BE-12 peer never connected: sender gets a clear error and no render starts', async t => {
  let renders = 0;
  const app = await start({ deps: { synthesize: async () => { renders++; throw new Error('should not render'); } } }); t.after(() => app.close());
  const r = await speak(app, 'aryan');
  const msg = errorMessage(r);
  assert.ok(msg && msg.length > 8, `no clear error: status=${r.status} raw=${r.raw.slice(0, 200)}`);
  assert.ok(!r.events.some(e => ['cleaned', 'done'].includes(e.type)), 'pipeline ran for an absent peer');
  assert.equal(renders, 0, 'TTS render started with nobody listening');
});

test('BE-13 heartbeat ":ping" arrives within ~16s', { timeout: 25000 }, async t => {
  const app = await start(); t.after(() => app.close());
  const c = await sse(app, 'aryan'); await c.next(e => e.event === 'hello');
  await c.next(e => e.event === ':ping', 17000);
});

test('BE-14/18/19 mock-mode flow: caption then clip to peer, sender gets no audio, ack -> delivered', async t => {
  const app = await start(); t.after(() => app.close());
  const rohit = await sse(app, 'rohit'), aryan = await sse(app, 'aryan');
  await rohit.next(e => e.event === 'hello');
  const r = await speak(app, 'aryan');
  assert.equal(r.status, 200);
  const types = r.events.map(e => e.type);
  assert.ok(types.every(x => ['status', 'preview', 'cleaned', 'done', 'error'].includes(x)), 'sender saw: ' + types);
  assert.ok(types.includes('cleaned') && types.at(-1) === 'done');
  assert.ok(!/"audio"|"format"|base64/.test(r.raw), 'audio leaked to sender stream');
  const cap = await rohit.next(e => e.event === 'caption'); const clip = await rohit.next(e => e.event === 'clip');
  assert.ok(cap.at <= clip.at, 'clip before caption');
  assert.deepEqual(Object.keys(cap.data).sort(), ['from', 'id', 'text']);
  for (const k of ['id', 'from', 'seq', 'of', 'mime', 'url', 'seconds']) assert.ok(k in clip.data, 'clip missing ' + k);
  assert.equal(cap.data.from, 'aryan'); assert.equal(clip.data.of, 1);
  const bytes = await clipText(app, clip);
  assert.equal(bytes.status, 200); assert.ok(bytes.text.length > 100); assert.ok(clip.data.mime.startsWith('audio/'));
  assert.ok(!aryan.names().includes('caption') && !aryan.names().includes('clip'), 'sender got its own caption/clip');
  // ack
  const own = await fetch(url(app.base, '/api/call/ack', { as: 'aryan' }), { method: 'POST', body: JSON.stringify({ id: clip.data.id }), headers: { 'Content-Type': 'application/json' } });
  assert.ok(own.status >= 400 && own.status < 500, 'sender acking its own message should be refused, got ' + own.status);
  const bogus = await fetch(url(app.base, '/api/call/ack', { as: 'rohit' }), { method: 'POST', body: JSON.stringify({ id: 'nope' }), headers: { 'Content-Type': 'application/json' } });
  assert.ok([200, 404].includes(bogus.status), 'bogus ack status ' + bogus.status);
  assert.ok(!aryan.names().includes('delivered'), 'delivered fired for an ack by the wrong side or a bogus id');
  const ok = await fetch(url(app.base, '/api/call/ack', { as: 'rohit' }), { method: 'POST', body: JSON.stringify({ id: clip.data.id }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 200);
  const d = await aryan.next(e => e.event === 'delivered'); assert.equal(d.data.id, clip.data.id);
  // malformed ack bodies never crash
  for (const body of ['', 'not json', '[]', 'null', '{"id":{"$gt":""}}', '{"id":1}', '{"id":"' + 'x'.repeat(100000) + '"}']) {
    const r2 = await fetch(url(app.base, '/api/call/ack', { as: 'rohit' }), { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    assert.ok(r2.status < 500, `ack body ${body.slice(0, 20)} -> ${r2.status}`); await r2.body?.cancel();
  }
});

async function liveApp(t, scenario, env = {}) {
  const fp = fakeProviders(scenario);
  const app = await start({ env: { ...LIVE_ENV, ...env }, deps: { fetchImpl: fp.fetchImpl } });
  t.after(() => app.close());
  return { app, fp };
}

test('BE-14 two utterances back to back arrive in the order they were sent', async t => {
  const { app } = await liveApp(t, { renderMs: 80 });
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  const p1 = speak(app, 'aryan', { body: Buffer.from('First sentence here.') });
  await delay(30);
  const p2 = speak(app, 'aryan', { body: Buffer.from('Second sentence here.') });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  const caps = []; for (let i = 0; i < 2; i++) caps.push((await rohit.next(e => e.event === 'caption', 8000)).data.text);
  assert.deepEqual(caps, ['First sentence here.', 'Second sentence here.']);
  const clips = []; for (let i = 0; i < 2; i++) clips.push(await clipText(app, await rohit.next(e => e.event === 'clip', 8000)));
  assert.deepEqual(clips.map(c => c.text), ['First sentence here.', 'Second sentence here.']);
});

test('BE-14b a fast second utterance must not overtake a slow first one', async t => {
  const { app } = await liveApp(t, { renderMs: 50, google: async text => { if (text.startsWith('First')) await delay(600); } });
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  const p1 = speak(app, 'aryan', { body: Buffer.from('First sentence here.') });
  await delay(50);
  const p2 = speak(app, 'aryan', { body: Buffer.from('Second sentence here.') });
  await Promise.all([p1, p2]);
  const caps = []; for (let i = 0; i < 2; i++) caps.push((await rohit.next(e => e.event === 'caption', 8000)).data.text);
  const clips = []; for (let i = 0; i < 2; i++) clips.push((await clipText(app, await rohit.next(e => e.event === 'clip', 8000))).text);
  assert.deepEqual({ caps, clips }, { caps: ['First sentence here.', 'Second sentence here.'], clips: ['First sentence here.', 'Second sentence here.'] },
    'utterances arrived out of the order they were spoken');
});

test('BE-15 text over 600 chars is split in order, each clip <= 600 chars, seq/of consistent', async t => {
  const { app, fp } = await liveApp(t);
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  const text = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i + 1} of the long call.`).join(' ');
  assert.ok(text.length > 2500);
  const r = await speak(app, 'aryan', { body: Buffer.from(text) });
  assert.equal(r.status, 200, r.raw.slice(0, 300)); assert.ok(r.events.at(-1).type === 'done', r.raw.slice(-300));
  const clips = [];
  const first = await rohit.next(e => e.event === 'clip', 8000); clips.push(first);
  const of = first.data.of; assert.ok(of >= 5, 'expected >=5 clips, got of=' + of);
  while (clips.length < of) clips.push(await rohit.next(e => e.event === 'clip', 15000));
  assert.deepEqual(clips.map(c => c.data.seq), clips.map((_, i) => i));
  assert.ok(clips.every(c => c.data.of === of && c.data.id !== undefined));
  const texts = []; for (const c of clips) texts.push((await clipText(app, c)).text);
  assert.ok(texts.every(x => x.length > 0 && x.length <= 600), 'lengths ' + texts.map(x => x.length));
  assert.equal(texts.join(' ').replace(/\s+/g, ' ').trim(), text, 'text lost, duplicated or reordered when split');
  assert.equal(fp.state.speakPosts, of, 'one voice job per clip');
});

test('BE-16 origin check: mismatched Origin 403; TRUST_PROXY honours forwarded headers; no bypass without it', async t => {
  const post = (app, headers) => fetch(url(app.base, '/api/call/speak', { as: 'aryan' }), { method: 'POST', body: AUDIO, headers: { 'Content-Type': 'audio/webm', ...headers } }).then(async r => (await r.body?.cancel(), r.status));
  const plain = await start(); t.after(() => plain.close());
  await sse(plain, 'rohit');
  assert.equal(await post(plain, { Origin: 'https://evil.example' }), 403, 'cross origin POST allowed');
  assert.equal(await post(plain, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'cross-site fetch-metadata allowed');
  // spoofed forwarded headers must not open the gate when TRUST_PROXY is off
  assert.equal(await post(plain, { Origin: 'https://evil.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example' }), 403, 'forwarded headers honoured without TRUST_PROXY');
  assert.equal(await post(plain, { Origin: plain.base }), 200, 'same-origin should pass');
  const proxied = await start({ env: { TRUST_PROXY: '1' } }); t.after(() => proxied.close());
  await sse(proxied, 'rohit');
  assert.equal(await post(proxied, { Origin: 'https://call.example.com', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'call.example.com' }), 200, 'TRUST_PROXY=1 + forwarded https rejected');
  assert.equal(await post(proxied, { Origin: 'https://call.example.com', 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'call.example.com' }), 403, 'proto mismatch accepted');
  assert.equal(await post(proxied, { Origin: 'https://evil.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'call.example.com' }), 403, 'host mismatch accepted');
});

test('BE-17 spend cap: renders past CALL_MAX_LINES are blocked before any provider call', async t => {
  const { app, fp } = await liveApp(t, {}, { CALL_MAX_LINES: '2' });
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  await sse(app, 'aryan');
  const out = [];
  for (let i = 0; i < 4; i++) out.push(await speak(app, i % 2 ? 'rohit' : 'aryan', { body: Buffer.from(`Line ${i + 1}.`) }));
  const posts = fp.state.speakPosts;
  console.log('    statuses:', out.map(r => r.status + ':' + (r.events.at(-1)?.type ?? r.json?.code)).join(' '), 'voice posts:', posts);
  assert.ok(posts <= 2, `voice jobs created: ${posts} (cap 2)`);
  const blocked = out.slice(2);
  assert.ok(blocked.every(r => errorMessage(r) && errorMessage(r).length > 8), 'blocked requests need a plain message: ' + JSON.stringify(blocked.map(errorMessage)));
});
