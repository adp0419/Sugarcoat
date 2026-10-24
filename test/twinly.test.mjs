import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwinlyAdapter } from '../lib/tts/twinly.mjs';
import { readConfig } from '../lib/config.mjs';
import { cleanWithGoogle } from '../lib/providers.mjs';

const config = overrides => ({ ...readConfig({}), twinlyKey: 'private-key', ...overrides });
const done = (result = { audio_b64: Buffer.from('MP4 audio').toString('base64'), mime: 'audio/mp4', seconds: 1 }) =>
  Response.json({ id: 'voice-job', status: 'done', result });
const input = () => ({ text: 'Meet Wednesday.', signal: new AbortController().signal });

test('Twinly uses owner clone, server Bearer auth and documented job endpoints', async () => {
  const calls = [], statuses = [];
  const synthesize = createTwinlyAdapter(config(), async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.headers.Authorization, 'Bearer private-key');
    if (init.method === 'POST') {
      assert.ok(url.endsWith('/voice/speak?wait=0'));
      assert.deepEqual(JSON.parse(init.body), { text: 'Meet Wednesday.' });
      return Response.json({ id: 'voice-job', status: 'queued' }, { status: 202 });
    }
    assert.ok(url.endsWith('/jobs/voice-job?wait=25'));
    return done();
  });
  const result = await synthesize({ ...input(), onStatus: async status => statuses.push(status) });
  assert.deepEqual(result.format, { encoding: 'encoded', mimeType: 'audio/mp4' });
  const chunks = []; for await (const chunk of result.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'MP4 audio');
  assert.equal(calls.length, 2); assert.deepEqual(statuses, ['Twinly voice queued']);
});
test('Twinly enforces 600 characters without truncating or billing extra jobs', async () => {
  let calls = 0;
  const synthesize = createTwinlyAdapter(config(), async () => { calls++; return done(); });
  await assert.rejects(synthesize({ ...input(), text: 'a'.repeat(601) }), /600 characters/);
  assert.equal(calls, 0);
});
test('Twinly surfaces Mac/voice setup errors', async () => {
  const synthesize = createTwinlyAdapter(config(), async () => Response.json({ error: { code: 'twinly_offline' } }, { status: 409 }));
  await assert.rejects(synthesize(input()), /Open Twinly/);
  const noVoice = createTwinlyAdapter(config(), async () => Response.json({ id: 'job', status: 'failed', error: { code: 'voice_not_set_up' } }));
  await assert.rejects(noVoice(input()), /Build your voice clone/);
});
test('Twinly never retries ambiguous job creation or billing failures', async () => {
  for (const code of ['job_unverified', 'billing_unverified', 'billing_record_failed']) {
    let calls = 0;
    const synthesize = createTwinlyAdapter(config(), async () => {
      calls++; return Response.json({ error: { code } }, { status: 503, headers: { 'Retry-After': '0' } });
    });
    await assert.rejects(synthesize(input()), /before trying again/); assert.equal(calls, 1);
  }
});
test('Twinly retries only safe job submission errors within a bounded wait', async () => {
  let calls = 0;
  const synthesize = createTwinlyAdapter(config(), async () => ++calls === 1
    ? Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'Retry-After': '0' } }) : done());
  await synthesize(input()); assert.equal(calls, 2);
  const limited = createTwinlyAdapter(config(), async () =>
    Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'Retry-After': '60' } }));
  await assert.rejects(limited(input()), error => error.retryAfter === 60);
});
test('Cancel aborts waiting and requests cancellation of a known queued job', async () => {
  const controller = new AbortController(), calls = [];
  const synthesize = createTwinlyAdapter(config(), async (url, init) => {
    calls.push(url);
    if (url.endsWith('/cancel')) {
      assert.equal(init.signal.aborted, false);
      return Response.json({ id: 'job', status: 'canceled' });
    }
    return Response.json({ id: 'job', status: 'queued' }, { status: 202 });
  });
  await assert.rejects(synthesize({ text: 'Hello.', signal: controller.signal,
    onStatus: async () => controller.abort() }), { name: 'AbortError' });
  assert.ok(calls.some(url => url.endsWith('/jobs/job/cancel')));
  assert.equal(calls.length, 2);
});
test('running voice cancellation limitations do not leave the client hanging', async () => {
  const controller = new AbortController();
  const synthesize = createTwinlyAdapter(config(), async url => url.endsWith('/cancel')
    ? Response.json({ error: { code: 'job_running' } }, { status: 409 })
    : Response.json({ id: 'job', status: 'running' }, { status: 202 }));
  await assert.rejects(synthesize({ text: 'Hello.', signal: controller.signal,
    onStatus: async () => controller.abort() }), { name: 'AbortError' });
});
test('Twinly rejects malformed base64, unexpected formats and oversized results', async () => {
  for (const result of [{ audio_b64: '!!!!', mime: 'audio/mp4' }, { audio_b64: 'AA==', mime: 'text/html' }]) {
    const synthesize = createTwinlyAdapter(config(), async () => done(result));
    await assert.rejects(synthesize(input()), /invalid audio/);
  }
  const synthesize = createTwinlyAdapter(config({ maxTtsBytes: 2 }), async () => done());
  await assert.rejects(synthesize(input()), /size limit/);
});
test('non-streaming Gemma preserves final text and omits invented first-token timing', async () => {
  const timings = { llmFirstTokenMs: null };
  const result = await cleanWithGoogle('Tuesday, no, Wednesday.', config({ mode: 'live', googleStream: false }),
    input().signal, async () => {}, timings, async (url, init) => {
      assert.ok(url.endsWith(':generateContent'));
      assert.equal(JSON.parse(init.body).generationConfig.thinkingConfig.thinkingLevel, 'minimal');
      return Response.json({ candidates: [{ content: { parts: [{ text: '', thought: true }, { text: 'Wednesday.' }] }, finishReason: 'STOP' }] });
    });
  assert.equal(result, 'Wednesday.'); assert.equal(timings.llmFirstTokenMs, null);
});
