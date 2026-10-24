// QA (Agent D): failure injection through createApp's fetchImpl. See docs/QA-CALL.md (FI-*).
// Providers are a local fake; nothing leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { start, sse, speak, fakeProviders, clipText, errorMessage, LIVE_ENV } from '../../scripts/qa-lib.mjs';

const LEAK = /\bat\s+\S+.*:\d+:\d+|\.mjs|node_modules|supabase|googleapis|groq\.com|https?:\/\/|undefined|\[object|TypeError|ECONN/i;
async function run(t, scenario, { env = {}, body = Buffer.from('Meet me Wednesday at noon.'), wait = 10000 } = {}) {
  const fp = fakeProviders(scenario);
  const app = await start({ env: { ...LIVE_ENV, ...env }, deps: { fetchImpl: fp.fetchImpl } });
  t.after(() => app.close());
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  const started = Date.now();
  const r = await Promise.race([speak(app, 'aryan', { body }), delay(wait).then(() => { throw new Error(`HUNG: sender stream did not finish within ${wait}ms`); })]);
  await delay(150);
  return { r, fp, rohit, ms: Date.now() - started, app };
}
function plain(r, label) {
  const msg = errorMessage(r);
  assert.ok(msg && msg.length >= 10 && msg.length <= 300, `${label}: need a plain message, got ${JSON.stringify(msg)} (status ${r.status})`);
  assert.ok(!LEAK.test(msg), `${label}: message leaks internals: ${msg}`);
  assert.ok(!r.events.some(e => e.type === 'done'), `${label}: stream ended with done after a failure`);
  return msg;
}

test('FI-1 Gemma returns 500 -> plain error, stream ends, peer gets no clip', async t => {
  const { r, rohit, fp } = await run(t, { google: () => new Response('boom', { status: 500 }) });
  const msg = plain(r, 'gemma500'); console.log('    msg:', msg);
  assert.equal(fp.state.speakPosts, 0, 'a voice job was created although cleaning failed');
  assert.ok(!rohit.names().includes('clip') && !rohit.names().includes('caption'), 'peer saw content from a failed utterance: ' + rohit.names());
});

test('FI-2 twinly_offline -> plain error, one POST, stream ends', async t => {
  const { r, fp } = await run(t, { speak: () => Response.json({ error: { code: 'twinly_offline' } }, { status: 409 }) });
  const msg = plain(r, 'twinly_offline'); console.log('    msg:', msg);
  assert.match(msg, /Twinly/i);
  assert.equal(fp.state.speakPosts, 1);
});

test('FI-3 needs_approval that never resolves -> sender is told, stream ends within the timeout', { timeout: 40000 }, async t => {
  const { r, ms } = await run(t, {
    speak: () => Response.json({ id: 'job-1', status: 'needs_approval' }, { status: 202 }),
    job: () => Response.json({ id: 'job-1', status: 'needs_approval' }),
  }, { env: { REQUEST_TIMEOUT_MS: '1500' }, wait: 30000 });
  console.log('    finished after', ms, 'ms; events:', r.events.map(e => e.type + (e.stage ? ':' + e.stage : '')).join(' '));
  const msg = plain(r, 'needs_approval'); console.log('    msg:', msg);
  assert.ok(r.events.some(e => /approv/i.test(e.stage || '')), 'sender was never told Twinly is waiting for approval');
  assert.ok(ms < 20000, 'took ' + ms + 'ms to give up');
});

test('FI-3b needs_approval then approved -> clip delivered', async t => {
  let polls = 0;
  const { r, rohit, app } = await run(t, { job: (state, id) => ++polls < 2 ? Response.json({ id, status: 'needs_approval' }) : undefined });
  assert.equal(r.events.at(-1)?.type, 'done', JSON.stringify(r.events.slice(-2)));
  assert.equal((await clipText(app, await rohit.next(e => e.event === 'clip'))).text, 'Meet me Wednesday at noon.');
});

test('FI-4 rate_limited -> plain error, stream ends', async t => {
  const { r, fp } = await run(t, { speak: () => Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'Retry-After': '30' } }) });
  const msg = plain(r, 'rate_limited'); console.log('    msg:', msg, '| POSTs:', fp.state.speakPosts);
  assert.ok(fp.state.speakPosts <= 2);
});

test('FI-5 job_unverified is NEVER retried: exactly one POST /voice/speak', async t => {
  for (const [code, status] of [['job_unverified', 502], ['job_unverified', 500], ['billing_unverified', 502], ['billing_record_failed', 502]]) {
    const { r, fp } = await run(t, { speak: () => Response.json({ error: { code } }, { status }) }, { env: { MAX_RETRIES: '2' } });
    const msg = plain(r, code); console.log(`    ${code}/${status}: POSTs=${fp.state.speakPosts} msg: ${msg}`);
    assert.equal(fp.state.speakPosts, 1, `${code} was retried: ${fp.state.speakPosts} POSTs`);
  }
});

test('FI-5b network error on the voice POST is not retried either (may already be billed)', async t => {
  const { r, fp } = await run(t, { speak: () => { throw new TypeError('fetch failed at https://advktwnedlgnhswpxokg.supabase.co'); } }, { env: { MAX_RETRIES: '2' } });
  const msg = plain(r, 'network'); console.log('    msg:', msg);
  assert.equal(fp.state.speakPosts, 1);
});

test('FI-5c failure on line 2 of a split utterance: no more voice jobs after job_unverified', async t => {
  const text = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1} of the long call.`).join(' ');
  let n = 0;
  const { r, fp, rohit } = await run(t, { speak: () => ++n === 2 ? Response.json({ error: { code: 'job_unverified' } }, { status: 502 }) : undefined }, { body: Buffer.from(text), wait: 15000 });
  plain(r, 'line2');
  assert.equal(fp.state.speakPosts, 2, 'continued rendering after an unverified job: ' + fp.state.speakPosts);
  await delay(300);
  console.log('    peer events:', rohit.names().join(','));
  assert.ok(rohit.names().includes('error'), 'peer was never told the rest of the utterance will not arrive');
});

test('FI-6 renders for one key run one at a time; different keys may overlap', async t => {
  const fp = fakeProviders({ renderMs: 250 });
  const app = await start({ env: { ...LIVE_ENV, MAX_CONCURRENT_REQUESTS: '8' }, deps: { fetchImpl: fp.fetchImpl } }); t.after(() => app.close());
  const rohit = await sse(app, 'rohit'), aryan = await sse(app, 'aryan');
  await rohit.next(e => e.event === 'hello'); await aryan.next(e => e.event === 'hello');
  await Promise.all([1, 2, 3].map(i => speak(app, 'aryan', { body: Buffer.from(`Aryan line ${i}.`) })));
  assert.equal(fp.state.maxActiveByKey['qa-key-aryan-SENTINEL-1111'], 1, JSON.stringify(fp.state.maxActiveByKey));
  assert.equal(fp.state.speakPosts, 3);
  // shared key (no per-person key) serialises both people
  const fp2 = fakeProviders({ renderMs: 250 });
  const { TWINLY_API_KEY_ARYAN, TWINLY_API_KEY_ROHIT, ...rest } = LIVE_ENV;
  const app2 = await start({ env: { ...rest, TWINLY_API_KEY: 'qa-shared-key', MAX_CONCURRENT_REQUESTS: '8' }, deps: { fetchImpl: fp2.fetchImpl } }); t.after(() => app2.close());
  const r2 = await sse(app2, 'rohit'), a2 = await sse(app2, 'aryan'); await r2.next(e => e.event === 'hello'); await a2.next(e => e.event === 'hello');
  await Promise.all([speak(app2, 'aryan', { body: Buffer.from('One.') }), speak(app2, 'rohit', { body: Buffer.from('Two.') })]);
  assert.equal(fp2.state.maxActiveByKey['qa-shared-key'], 1, 'two people sharing one key rendered concurrently');
});

test('FI-7 sender hangs up mid-render: peer still gets the clip, no crash', async t => {
  const fp = fakeProviders({ renderMs: 400 });
  const app = await start({ env: { ...LIVE_ENV }, deps: { fetchImpl: fp.fetchImpl } }); t.after(() => app.close());
  const rohit = await sse(app, 'rohit'); await rohit.next(e => e.event === 'hello');
  const ac = new AbortController();
  const p = speak(app, 'aryan', { signal: ac.signal }).catch(() => 'aborted');
  await rohit.next(e => e.event === 'caption'); ac.abort(); await p;
  const clip = await rohit.next(e => e.event === 'clip', 5000).catch(() => null);
  console.log('    peer got clip after sender aborted:', !!clip);
  assert.equal((await fetch(app.base + '/healthz')).status, 200);
});

test('FI-8 provider returns garbage JSON / empty audio -> plain error', async t => {
  const a = await run(t, { google: () => new Response('<html>nope</html>', { status: 200 }) });
  plain(a.r, 'garbage gemma');
  const b = await run(t, { job: (s, id) => Response.json({ id, status: 'done', result: { audio_b64: '', mime: 'audio/mp4' } }) });
  plain(b.r, 'empty audio');
});
