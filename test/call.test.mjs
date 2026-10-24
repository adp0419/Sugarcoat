import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { createCall, splitForTts } from '../lib/call.mjs';
import { MOCK_CLEANED } from '../lib/cleanup.mjs';

const quiet = { info() {} };
const TOKEN = 'test-token';
const config = overrides => ({ ...readConfig({}), callToken: TOKEN, ...overrides });
const mp3 = text => ({ format: { encoding: 'encoded', mimeType: 'audio/mpeg' },
  stream: (async function* () { yield Buffer.from(`voice:${text}`); })() });

async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, overrides = {}, dependencies = {}) {
  const server = await createApp(config(overrides), { logger: quiet, ...dependencies });
  const base = await listen(t, server);
  const url = (path, as, token = TOKEN) => `${base}${path}?${as ? `as=${as}&` : ''}t=${token}`;
  return { base, url, speak: (as, body = Buffer.from('audio'), headers = {}) => fetch(url('/api/call/speak', as), {
    method: 'POST', headers: { 'Content-Type': 'audio/webm', ...headers }, body }) };
}

// Minimal SSE client: collects events and lets a test wait for one.
function listenEvents(t, urlString, headers = {}) {
  const controller = new AbortController();
  const events = [], waiters = [], raw = [];
  const done = (async () => {
    try {
      const response = await fetch(urlString, { signal: controller.signal, headers });
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          raw.push(block);
          const event = /^event: (.+)$/mu.exec(block)?.[1], data = /^data: (.+)$/mu.exec(block)?.[1];
          if (event) events.push({ event, data: JSON.parse(data), id: Number(/^id: (\d+)$/mu.exec(block)?.[1]) });
          for (const waiter of [...waiters]) waiter();
        }
      }
    } catch { /* aborted */ }
  })();
  const client = {
    events, raw, close: () => controller.abort(), done,
    async waitFor(predicate, ms = 3000) {
      const deadline = Date.now() + ms;
      while (true) {
        const hit = events.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`Timed out; saw ${JSON.stringify(events.map(e => e.event))}`);
        await new Promise(resolve => { const timer = setTimeout(resolve, 25); waiters.push(() => { clearTimeout(timer); resolve(); }); });
      }
    },
    names: () => events.map(e => e.event),
  };
  t.after(() => client.close());
  return client;
}
const connect = async (t, f, as, headers) => {
  const client = listenEvents(t, f.url('/api/call/events', as), headers);
  await client.waitFor(e => e.event === 'hello');
  return client;
};
const ndjson = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));

test('speech flows sender to peer in both directions, with no audio for the sender', async t => {
  const f = await fixture(t, {}, { synthesize: async ({ text }) => mp3(text) });
  const aryan = await connect(t, f, 'aryan'), rohit = await connect(t, f, 'rohit');
  assert.deepEqual(aryan.events[0].data, { you: 'aryan', peer: 'rohit', peerOnline: false });
  assert.deepEqual(rohit.events[0].data, { you: 'rohit', peer: 'aryan', peerOnline: true });
  for (const [from, to, listener, other] of [['aryan', 'rohit', rohit, aryan], ['rohit', 'aryan', aryan, rohit]]) {
    const response = await f.speak(from);
    assert.equal(response.status, 200);
    const lines = await ndjson(response);
    assert.deepEqual([...new Set(lines.map(l => l.type))], ['status', 'preview', 'cleaned', 'done']);
    assert.equal(lines.at(-1).type, 'done');
    assert.ok(!lines.some(l => l.type === 'audio' || l.type === 'format'));
    const id = lines.find(l => l.type === 'cleaned').id;
    const caption = await listener.waitFor(e => e.event === 'caption' && e.data.id === id);
    const clip = await listener.waitFor(e => e.event === 'clip' && e.data.id === id);
    assert.deepEqual(caption.data, { id, from, text: MOCK_CLEANED });
    assert.ok(caption.id < clip.id, 'caption precedes clip');
    assert.deepEqual({ ...clip.data, seconds: undefined }, { id, from, seq: 0, of: 1, mime: 'audio/mpeg', url: `/api/call/clip/${id}-0`, seconds: undefined });
    assert.ok(!other.events.some(e => e.data.id === id), 'sender gets neither caption nor clip');
    const audio = await fetch(`${f.base}${clip.data.url}?t=${TOKEN}`);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await audio.text(), `voice:${MOCK_CLEANED}`);
    assert.ok(to);
  }
});

test('wrong or missing token is 401, unknown name is 400, unset token is 503', async t => {
  const f = await fixture(t, {}, { synthesize: async () => mp3('x') });
  for (const path of ['/api/call/events', '/api/call/speak', '/api/call/ack']) {
    const method = path === '/api/call/events' ? 'GET' : 'POST';
    assert.equal((await fetch(f.url(path, 'aryan', 'nope'), { method })).status, 401);
    assert.equal((await fetch(`${f.base}${path}?as=aryan`, { method })).status, 401);
    assert.equal((await fetch(f.url(path, 'mallory'), { method })).status, 400);
    assert.equal((await fetch(`${f.base}${path}`, { method })).status, 401);
  }
  assert.equal((await fetch(`${f.base}/api/call/clip/abc-0?t=nope`)).status, 401);
  const open = await fixture(t, { callToken: '' });
  assert.equal((await fetch(open.url('/api/call/events', 'aryan', 'anything'))).status, 503);
  const body = await (await fetch(open.url('/api/call/events', 'aryan', ''))).json();
  assert.match(body.error, /CALL_TOKEN/);
  assert.ok(!JSON.stringify(body).includes(TOKEN));
});

test('renders never overlap on one key but different keys run in parallel', async t => {
  let running = 0, peak = 0;
  const synthesize = async ({ text }) => {
    running++; peak = Math.max(peak, running);
    await delay(60);
    running--;
    return mp3(text);
  };
  const shared = await fixture(t, {}, { synthesize });
  await connect(t, shared, 'aryan'); await connect(t, shared, 'rohit');
  const runs = await Promise.all([shared.speak('aryan'), shared.speak('aryan'), shared.speak('rohit')]);
  for (const run of runs) assert.equal((await ndjson(run)).at(-1).type, 'done');
  assert.equal(peak, 1);

  peak = 0;
  const split = await fixture(t, { callKeys: { aryan: 'key-a', rohit: 'key-r' } }, { synthesize });
  await connect(t, split, 'aryan'); await connect(t, split, 'rohit');
  await Promise.all([split.speak('aryan'), split.speak('rohit')].map(async run => (await run).text()));
  assert.equal(peak, 2);
});

test('each speaker renders with their own Twinly key', async t => {
  const keys = [];
  const f = await fixture(t, { callKeys: { aryan: 'key-a', rohit: 'key-r' } },
    { synthesize: async ({ text, apiKey }) => { keys.push(apiKey); return mp3(text); } });
  await connect(t, f, 'aryan'); await connect(t, f, 'rohit');
  await (await f.speak('aryan')).text(); await (await f.speak('rohit')).text();
  assert.deepEqual(keys, ['key-a', 'key-r']);
});

test('twinly provider builds one adapter per person and rejects a missing key before any call', async t => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    return Response.json({ id: 'job1', status: 'done', result: { mime: 'audio/mpeg', audio_b64: Buffer.from('mp3').toString('base64') } });
  };
  const f = await fixture(t, { ttsProvider: 'twinly', callKeys: { aryan: 'key-a', rohit: 'key-r' } }, { fetchImpl });
  await connect(t, f, 'aryan'); await connect(t, f, 'rohit');
  await (await f.speak('aryan')).text(); await (await f.speak('rohit')).text();
  assert.deepEqual(seen, ['Bearer key-a', 'Bearer key-r']);
  const none = await fixture(t, { ttsProvider: 'twinly', twinlyKey: '', callKeys: { aryan: 'key-a', rohit: '' } }, { fetchImpl });
  await connect(t, none, 'aryan'); await connect(t, none, 'rohit');
  seen.length = 0;
  const response = await none.speak('rohit');
  assert.equal(response.status, 503);
  assert.deepEqual(seen, []);
});

test('splitting yields ordered sentence chunks of at most 600 characters', () => {
  const sentence = 'This is a sentence of moderate length that keeps going for a while. ';
  const text = sentence.repeat(30).trim();
  const chunks = splitForTts(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 600));
  assert.equal(chunks.join(' '), text);
  assert.ok(chunks.every(chunk => chunk.endsWith('.')));
  const wall = splitForTts('word '.repeat(400).trim());
  assert.ok(wall.every(chunk => chunk.length <= 600) && wall.join(' ') === 'word '.repeat(400).trim());
  assert.ok(splitForTts('x'.repeat(1500)).every(chunk => chunk.length <= 600));
  assert.deepEqual(splitForTts('Short.'), ['Short.']);
});

test('long cleaned text becomes several clips, rendered and published in order', async t => {
  const long = Array.from({ length: 25 }, (_, i) => `Sentence number ${i} says something rather ordinary today.`).join(' ');
  const rendered = [];
  const f = await fixture(t, { mode: 'live', groqKey: 'g', googleKey: 'k', googleStream: false },
    { synthesize: async ({ text }) => { rendered.push(text); return mp3(text); },
      fetchImpl: async url => url.includes('groq') ? Response.json({ text: 'raw words' })
        : Response.json({ candidates: [{ content: { parts: [{ text: long }] }, finishReason: 'STOP' }] }) });
  await connect(t, f, 'aryan');
  const rohit = await connect(t, f, 'rohit');
  const lines = await ndjson(await f.speak('aryan'));
  assert.equal(lines.at(-1).type, 'done', JSON.stringify(lines.at(-1)));
  await rohit.waitFor(e => e.event === 'clip' && e.data.seq === e.data.of - 1);
  const clips = rohit.events.filter(e => e.event === 'clip').map(e => e.data);
  assert.ok(clips.length >= 2, `clips ${clips.length}`);
  assert.deepEqual(clips.map(c => c.seq), clips.map((_, i) => i));
  assert.ok(clips.every(c => c.of === clips.length));
  assert.ok(rendered.every(text => text.length <= 600));
  assert.equal(rendered.join(' '), long);
  assert.equal(rohit.events.filter(e => e.event === 'caption').length, 1);
  assert.equal(rohit.names()[1], 'caption');
});

test('clips expire after the TTL and the store is size-capped', async t => {
  let clock = 1000;
  const call = createCall(config({}), { synthesize: async ({ text }) => mp3(text), logger: quiet, now: () => clock, clipTtlMs: 5000, clipMaxBytes: 40 });
  const server = http.createServer(async (req, res) => { if (!await call(req, res, req.url.split('?')[0])) res.end(); });
  const base = await listen(t, server);
  const rohit = listenEvents(t, `${base}/api/call/events?as=rohit&t=${TOKEN}`);
  await rohit.waitFor(e => e.event === 'hello');
  const speak = () => fetch(`${base}/api/call/speak?as=aryan&t=${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: 'a' }).then(r => r.text());
  await speak();
  const first = (await rohit.waitFor(e => e.event === 'clip')).data;
  assert.equal((await fetch(`${base}${first.url}?t=${TOKEN}`)).status, 200);
  const range = await fetch(`${base}${first.url}?t=${TOKEN}`, { headers: { Range: 'bytes=0-4' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'voice');
  clock += 5001;
  assert.equal((await fetch(`${base}${first.url}?t=${TOKEN}`)).status, 404);
  // Each clip is 36 bytes against a 40 byte cap: storing the next evicts the oldest.
  await speak(); await speak();
  await rohit.waitFor(e => e.event === 'clip' && e.data.url !== first.url && rohit.events.filter(x => x.event === 'clip').length === 3);
  const urls = rohit.events.filter(e => e.event === 'clip').map(e => e.data.url);
  assert.equal(urls.length, 3);
  assert.equal((await fetch(`${base}${urls[1]}?t=${TOKEN}`)).status, 404);
  assert.equal((await fetch(`${base}${urls[2]}?t=${TOKEN}`)).status, 200);
});

test('presence follows the peer connection and a reconnect replays missed events', async t => {
  const f = await fixture(t, {}, { synthesize: async ({ text }) => mp3(text) });
  const aryan = await connect(t, f, 'aryan');
  assert.equal(aryan.events[0].data.peerOnline, false);
  const rohit = await connect(t, f, 'rohit');
  assert.deepEqual((await aryan.waitFor(e => e.event === 'presence')).data, { peer: 'rohit', online: true });
  rohit.close();
  assert.deepEqual((await aryan.waitFor(e => e.event === 'presence' && !e.data.online)).data, { peer: 'rohit', online: false });
  // With the peer offline nothing is spent.
  let calls = 0;
  const idle = await fixture(t, {}, { synthesize: async ({ text }) => { calls++; return mp3(text); } });
  await connect(t, idle, 'aryan');
  const refused = await idle.speak('aryan');
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'PEER_OFFLINE');
  assert.equal(calls, 0);
  // Reconnect: online again, and events missed during a blip are replayed.
  const again = await connect(t, f, 'rohit');
  assert.equal(again.events[0].data.peerOnline, true);
  await aryan.waitFor(e => e.event === 'presence' && e.data.online && e.id > 0 && aryan.events.filter(x => x.event === 'presence').length === 3);
  await (await f.speak('aryan')).text();
  const seen = await again.waitFor(e => e.event === 'clip');
  again.close();
  const blip = listenEvents(t, f.url('/api/call/events', 'rohit'), { 'Last-Event-ID': '0' });
  await blip.waitFor(e => e.event === 'clip');
  assert.deepEqual(blip.names().filter(n => n === 'caption' || n === 'clip'), ['caption', 'clip']);
  assert.ok(seen);
});

test('ack from the peer produces delivered for the sender, once', async t => {
  const f = await fixture(t, {}, { synthesize: async ({ text }) => mp3(text) });
  const aryan = await connect(t, f, 'aryan'); await connect(t, f, 'rohit');
  const id = (await ndjson(await f.speak('aryan'))).find(l => l.type === 'cleaned').id;
  const ack = as => fetch(f.url('/api/call/ack', as), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  assert.equal((await ack('aryan')).status, 400, 'the sender cannot ack its own message');
  assert.equal((await ack('rohit')).status, 200);
  assert.equal((await ack('rohit')).status, 200);
  assert.deepEqual((await aryan.waitFor(e => e.event === 'delivered')).data, { id });
  await delay(50);
  assert.equal(aryan.events.filter(e => e.event === 'delivered').length, 1);
  const unknown = await fetch(f.url('/api/call/ack', 'rohit'), { method: 'POST', body: JSON.stringify({ id: 'nope' }) });
  assert.equal(unknown.status, 404);
});

test('the spend cap blocks further renders before any Twinly call', async t => {
  let calls = 0;
  const f = await fixture(t, { callMaxLines: 2 }, { synthesize: async ({ text }) => { calls++; return mp3(text); } });
  await connect(t, f, 'aryan'); const rohit = await connect(t, f, 'rohit');
  assert.equal((await ndjson(await f.speak('aryan'))).at(-1).type, 'done');
  assert.equal((await ndjson(await f.speak('rohit'))).at(-1).type, 'done');
  assert.equal(calls, 2);
  const blocked = await f.speak('aryan');
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, 'CALL_LINE_CAP');
  assert.equal(calls, 2);
  assert.ok(rohit.events.filter(e => e.event === 'caption').length === 1);

  // An utterance that would exceed the cap mid-way is refused whole: caption yes, voice no.
  const long = Array.from({ length: 25 }, (_, i) => `Sentence number ${i} says something rather ordinary today.`).join(' ');
  let renders = 0;
  const g = await fixture(t, { mode: 'live', groqKey: 'g', googleKey: 'k', googleStream: false, callMaxLines: 2 },
    { synthesize: async ({ text }) => { renders++; return mp3(text); },
      fetchImpl: async url => url.includes('groq') ? Response.json({ text: 'raw' })
        : Response.json({ candidates: [{ content: { parts: [{ text: long }] }, finishReason: 'STOP' }] }) });
  await connect(t, g, 'aryan'); const peer = await connect(t, g, 'rohit');
  const lines = await ndjson(await g.speak('aryan'));
  assert.equal(lines.at(-1).code, 'CALL_LINE_CAP');
  assert.equal(renders, 0);
  await peer.waitFor(e => e.event === 'error');
  assert.ok(!peer.names().includes('clip'));
});

test('call routes honor tunnel headers only with TRUST_PROXY', async t => {
  const origin = 'https://tunnel.example';
  const send = (f, headers) => fetch(f.url('/api/call/speak', 'aryan'), { method: 'POST', body: 'a',
    headers: { 'Content-Type': 'audio/webm', Origin: origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'tunnel.example', ...headers } });
  const trusting = await fixture(t, { trustProxy: true }, { synthesize: async ({ text }) => mp3(text) });
  await connect(t, trusting, 'rohit');
  assert.equal((await send(trusting)).status, 200);
  assert.equal((await send(trusting, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(trusting, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const plain = await fixture(t, {}, { synthesize: async ({ text }) => mp3(text) });
  assert.equal((await send(plain)).status, 403);
});

test('SSE sends a :ping comment on the heartbeat interval', async t => {
  const call = createCall(config({}), { logger: quiet, heartbeatMs: 40 });
  const server = http.createServer(async (req, res) => { if (!await call(req, res, req.url.split('?')[0])) res.end(); });
  const base = await listen(t, server);
  const events = listenEvents(t, `${base}/api/call/events?as=aryan&t=${TOKEN}`);
  await events.waitFor(e => e.event === 'hello');
  await delay(150);
  assert.ok(events.raw.some(block => block === ':ping'));
});

test('regression: /api/process still streams the same NDJSON sequence and ignores call config', async t => {
  const f = await fixture(t, { callToken: '' });
  const response = await fetch(`${f.base}/api/process`, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: Buffer.from('audio') });
  assert.equal(response.status, 200);
  const lines = await ndjson(response);
  const sequence = lines.map(l => l.type).filter((type, i, all) => type !== all[i - 1]);
  assert.deepEqual(sequence, ['status', 'preview', 'cleaned', 'format', 'audio', 'done']);
  assert.deepEqual(lines.filter(l => l.type === 'status').map(l => l.stage), ['transcribing', 'cleaning']);
  assert.equal(lines.find(l => l.type === 'cleaned').text, MOCK_CLEANED);
  assert.deepEqual(lines.find(l => l.type === 'format').format, { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  assert.equal((await fetch(`${f.base}/nope`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/process`)).status, 405);
});
