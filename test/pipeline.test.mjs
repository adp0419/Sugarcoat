import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';
import { preClean, MOCK_CLEANED, CLEANUP_INSTRUCTION } from '../lib/cleanup.mjs';
import { retryDelay, providerFetch, sseData } from '../lib/http.mjs';
import { transcribe, cleanWithGoogle } from '../lib/providers.mjs';
import { validateAudio } from '../lib/tts/index.mjs';

const quiet = { info() {} };
const signal = () => new AbortController().signal;
// These fixtures return SSE. The real default uses non-streaming Gemma.
const config = overrides => ({ ...readConfig({}), googleStream: true, ...overrides });
const frame = object => `data: ${JSON.stringify(object)}\r\n\r\n`;
function googleStream(text = 'Final wording.', finishReason = 'STOP') {
  return new Response(frame({ candidates: [{ content: { parts: [{ text }] } }] }) +
    frame({ candidates: [{ finishReason }] }), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function fixture(t, overrides = {}, dependencies = {}) {
  const server = await createApp(config(overrides), { logger: quiet, ...dependencies });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, post: (body = Buffer.from('test audio'), options = {}) => fetch(`${base}/api/process`, {
    method: 'POST', headers: { 'Content-Type': 'audio/webm', ...options.headers }, body, signal: options.signal,
  }) };
}
const events = async response => (await response.text()).trim().split('\n').map(line => JSON.parse(line));

test('pre-pass removes only narrow fillers, stutters and exact silence markers', () => {
  assert.equal(preClean(' Um,  th-that is, uh, fine. '), 'that is, fine.');
  assert.equal(preClean('[BLANK_AUDIO]'), '');
  for (const text of ['That that is true.', 'Very very good.', 'No-no, I mean it.', 'Say "um" twice.', 'Um is a word.', 'I, I disagree.', 'Actually, make that Thursday.']) {
    assert.equal(preClean(text), text);
  }
});
test('configuration rejects dangerous limits and invalid modes', () => {
  assert.throws(() => readConfig({ MAX_AUDIO_BYTES: '-1' }), /MAX_AUDIO_BYTES/);
  assert.throws(() => readConfig({ APP_MODE: 'unknown' }), /APP_MODE/);
});
test('Retry-After supports seconds and HTTP dates', () => {
  assert.equal(retryDelay('0.25'), 250);
  assert.equal(retryDelay('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:59 GMT')), 1000);
  assert.equal(retryDelay(null), null);
  assert.equal(retryDelay('invalid'), null);
});
test('one bounded retry honors Retry-After; long waits fail promptly', async () => {
  let calls = 0;
  const fake = async () => ++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : new Response('ok');
  assert.equal(await (await providerFetch('Test', 'https://example.com', () => ({}), config(), signal(), fake)).text(), 'ok');
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(providerFetch('Test', 'https://example.com', () => ({}), config(), signal(), async () => {
    calls++; return new Response('', { status: 429, headers: { 'Retry-After': '30' } });
  }), /Retry after 30 seconds/);
  assert.equal(calls, 1);
});
test('abort interrupts retry backoff', async () => {
  const controller = new AbortController();
  const promise = providerFetch('Test', 'https://example.com', () => ({}), config(), controller.signal,
    async () => new Response('', { status: 503, headers: { 'Retry-After': '1' } }));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { name: 'AbortError' });
});
test('a transient provider HTTP 500 gets one bounded retry', async () => {
  let calls = 0;
  const response = await providerFetch('Google', 'https://example.com', () => ({}), config(), signal(), async () =>
    ++calls === 1 ? new Response('', { status: 500, headers: { 'Retry-After': '0' } }) : new Response('ok'));
  assert.equal(await response.text(), 'ok'); assert.equal(calls, 2);
});
test('network failures are not retried and provider body secrets are not exposed', async () => {
  let calls = 0;
  await assert.rejects(providerFetch('Test', 'https://example.com', () => ({}), config(), signal(), async () => {
    calls++; throw new Error('private credential');
  }), /could not be reached/);
  assert.equal(calls, 1);
  await assert.rejects(providerFetch('Test', 'https://example.com', () => ({}), config(), signal(), async () =>
    new Response('private credential', { status: 401 })), /rejected the API key/);
});
test('SSE parser handles fragmented UTF-8, CRLF and multi-line frames', async () => {
  const encoded = new TextEncoder().encode(': comment\r\ndata: {"text":"café"}\r\n\r\ndata: one\ndata: two\n\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const values = [];
  for await (const data of sseData(stream, signal())) values.push(data);
  assert.deepEqual(values, ['{"text":"café"}', 'one\ntwo']);
});
test('Groq contract uses compressed multipart, exact model and server-only key', async () => {
  const result = await transcribe(Buffer.from('audio'), 'audio/webm', config({ mode: 'live', groqKey: 'private' }), signal(), async (url, init) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(init.headers.Authorization, 'Bearer private');
    assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(init.body.get('file').name, 'speech.webm');
    assert.equal(init.body.get('language'), 'en');
    assert.equal(init.body.get('response_format'), 'json');
    return Response.json({ text: 'Transcript.' });
  });
  assert.equal(result, 'Transcript.');
});
test('Google request preserves revision instructions, filters thoughts and requires completion', async () => {
  const previews = [], timings = { llmFirstTokenMs: null };
  const transcript = 'Tuesday. Actually, no, make that Wednesday. Scratch that, Thursday.';
  const output = await cleanWithGoogle(transcript, config({ mode: 'live', googleKey: 'private' }), signal(), async text => previews.push(text), timings,
    async (url, init) => {
      assert.match(url, /gemma-4-26b-a4b-it:streamGenerateContent\?alt=sse$/);
      assert.equal(init.headers['x-goog-api-key'], 'private');
      const body = JSON.parse(init.body);
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
      assert.ok(body.contents[0].parts[0].text.includes(CLEANUP_INSTRUCTION));
      assert.ok(body.contents[0].parts[0].text.includes(transcript));
      return new Response(frame({ candidates: [{ content: { parts: [{ text: 'reasoning', thought: true }] } }] }) +
        frame({ candidates: [{ content: { parts: [{ text: 'Thursday.' }] }, finishReason: 'STOP' }] }));
    });
  assert.equal(output, 'Thursday.'); assert.deepEqual(previews, ['Thursday.']);
  assert.equal(typeof timings.llmFirstTokenMs, 'number');
  await assert.rejects(cleanWithGoogle('Text', config({ mode: 'live' }), signal(), async () => {}, {}, async () => googleStream('Truncated', 'MAX_TOKENS')), /did not complete/);
});
test('audio adapter rejects unknown formats instead of guessing', () => {
  const stream = (async function* () { yield Buffer.alloc(2); })();
  assert.doesNotThrow(() => validateAudio({ format: { encoding: 'pcm_s16le', channels: 1, sampleRate: 24000 }, stream }));
  assert.throws(() => validateAudio({ format: { encoding: 'unknown' }, stream }), /unsupported/);
});

test('mock end-to-end emits final text, streamed PCM, timings and EOF', async t => {
  const { post } = await fixture(t);
  const response = await post(); assert.equal(response.status, 200);
  const list = await events(response);
  assert.equal(list.find(e => e.type === 'cleaned').text, MOCK_CLEANED);
  assert.ok(list.findIndex(e => e.type === 'cleaned') < list.findIndex(e => e.type === 'audio'));
  const chunks = list.filter(e => e.type === 'audio');
  assert.equal(chunks.length, 20);
  assert.equal(chunks.reduce((n, e) => n + Buffer.from(e.data, 'base64').length, 0), 48000);
  assert.equal(list.at(-1).type, 'done');
  for (const value of Object.values(list.at(-1).timings)) assert.equal(typeof value, 'number');
});
test('live pipeline contract calls Groq then Google then TTS with final text', async t => {
  const calls = [];
  const { post } = await fixture(t, { mode: 'live', groqKey: 'groq', googleKey: 'google' }, {
    fetchImpl: async url => {
      calls.push(url.includes('groq') ? 'stt' : 'google');
      return url.includes('groq') ? Response.json({ text: 'Actually, Thursday.' }) : googleStream('Thursday.');
    },
    synthesize: async ({ text, signal: abortSignal }) => {
      calls.push('tts'); assert.equal(text, 'Thursday.'); assert.equal(abortSignal.aborted, false);
      return { format: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }, stream: (async function* () { yield Buffer.alloc(2400); })() };
    },
  });
  assert.equal((await events(await post())).at(-1).type, 'done');
  assert.deepEqual(calls, ['stt', 'google', 'tts']);
});
test('incomplete cleanup never starts TTS; subsequent requests recover', async t => {
  let ttsCalled = false, fail = true;
  const { post } = await fixture(t, { mode: 'live', groqKey: 'groq', googleKey: 'google' }, {
    fetchImpl: async url => url.includes('groq') ? Response.json({ text: 'Hello.' }) : googleStream('Hello.', fail ? 'MAX_TOKENS' : 'STOP'),
    synthesize: async () => { ttsCalled = true; throw new Error('test'); },
  });
  const first = await events(await post()); assert.equal(first.at(-1).type, 'error'); assert.equal(ttsCalled, false);
  fail = false; await events(await post()); assert.equal(ttsCalled, true);
});
test('provider rate limit becomes an explicit stream error with timings', async t => {
  const { post } = await fixture(t, { mode: 'live', groqKey: 'x', googleKey: 'y' }, {
    fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
  });
  const list = await events(await post());
  assert.equal(list.at(-1).type, 'error'); assert.equal(list.at(-1).retryAfter, 60);
  assert.ok(list.at(-1).timings.sttMs >= 0);
});
test('missing credentials and Twinly setup fail explicitly before provider work', async t => {
  const live = await fixture(t, { mode: 'live' });
  assert.equal((await live.post()).status, 503);
  const twinly = await fixture(t, { ttsProvider: 'twinly' });
  const response = await twinly.post();
  assert.equal(response.status, 503); assert.match((await response.json()).error, /Twinly/);
});
test('input size, empty input, format, method and cross-origin limits', async t => {
  const { post, base } = await fixture(t, { maxAudioBytes: 1024 });
  assert.equal((await post(Buffer.alloc(1025))).status, 413);
  assert.equal((await post(Buffer.alloc(0))).status, 400);
  assert.equal((await post('text', { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await fetch(`${base}/api/process`)).status, 405);
  assert.equal((await post('x', { headers: { Origin: 'https://other.example' } })).status, 403);
});
test('static routing never serves keys or backend sources', async t => {
  const { base } = await fixture(t, { groqKey: 'very-private' });
  for (const path of ['/.env', '/server.mjs', '/lib/config.mjs', '/%2e%2e/.env']) assert.equal((await fetch(base + path)).status, 404);
  const response = await fetch(`${base}/api/config`);
  assert.ok(!(await response.text()).includes('very-private'));
  const page = await fetch(base); assert.equal(page.status, 200);
  assert.ok(page.headers.get('content-security-policy').includes("script-src 'self'"));
});
test('request timeout aborts upstream work and reports measured elapsed time', async t => {
  let upstreamAborted = false;
  const { post } = await fixture(t, { mode: 'live', groqKey: 'x', googleKey: 'y', timeoutMs: 100 }, {
    fetchImpl: async (_url, init) => {
      try { await delay(5000, undefined, { signal: init.signal }); }
      finally { upstreamAborted = init.signal.aborted; }
    },
  });
  const list = await events(await post());
  assert.equal(list.at(-1).code, 'TIMEOUT'); assert.equal(upstreamAborted, true);
  assert.ok(list.at(-1).timings.serverTotalMs >= 90);
});
test('canceling a response aborts TTS and releases concurrency capacity', async t => {
  let aborted;
  const abortedPromise = new Promise(resolve => { aborted = resolve; });
  const { post } = await fixture(t, { maxConcurrent: 1 }, {
    synthesize: async ({ signal: abortSignal }) => {
      abortSignal.addEventListener('abort', aborted, { once: true });
      return { format: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 }, stream: (async function* () {
        yield Buffer.alloc(2400); await delay(10000, undefined, { signal: abortSignal });
      })() };
    },
  });
  const controller = new AbortController();
  const response = await post('audio', { signal: controller.signal });
  const reader = response.body.getReader(); await reader.read();
  assert.equal((await post()).status, 429);
  controller.abort(); await reader.cancel().catch(() => {});
  await Promise.race([abortedPromise, delay(1000).then(() => { throw new Error('Upstream did not abort'); })]);
  await delay(10);
  const next = await post(); assert.equal(next.status, 200);
  await next.body.cancel();
});
