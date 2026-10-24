// Shared QA harness (Agent D). Used by test/qa/*.test.mjs. No product code is modified.
// Everything runs in-process on a random localhost port; provider traffic is a local fake (fetchImpl),
// so no real Twinly / Groq / Google call can happen.
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';

export const TOKEN = 'qa-token-8f3k2j5h1d9s7a6q';
export const KEY_ARYAN = 'qa-key-aryan-SENTINEL-1111';
export const KEY_ROHIT = 'qa-key-rohit-SENTINEL-2222';
export const GROQ = 'qa-groq-SENTINEL-3333';
export const GOOGLE = 'qa-google-SENTINEL-4444';
export const AUDIO = Buffer.from('fake audio bytes for qa');

export function makeLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
  return { lines, info: push, warn: push, error: push, log: push, debug: push };
}

// Start the real app. env overrides readConfig(); deps are createApp's injection points.
export async function start({ env = {}, deps = {} } = {}) {
  const config = readConfig({ APP_MODE: 'mock', TTS_PROVIDER: 'mock', CALL_TOKEN: TOKEN, HOST: '127.0.0.1', ...env });
  const logger = makeLogger();
  const server = await createApp(config, { logger, ...deps });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const open = new Set();
  return { base, server, config, logger, open,
    async close() { for (const s of open) s.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}

export const url = (base, path, o = {}) => {
  const as = o.as, t = 't' in o ? o.t : TOKEN; // explicit t: undefined means "no token"
  const q = []; if (as !== undefined) q.push(`as=${encodeURIComponent(as)}`); if (t !== undefined) q.push(`t=${encodeURIComponent(t)}`);
  return base + path + (q.length ? '?' + q.join('&') : '');
};

// SSE client over fetch. events: [{event, data}]; comments appear as {event:':ping'}.
export async function sse(app, as, { t = TOKEN, path } = {}) {
  const ac = new AbortController();
  const res = await fetch(path ? app.base + path : url(app.base, '/api/call/events', { as, t }), { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
  const client = { res, events: [], status: res.status, closed: false, waiters: [],
    close() { client.closed = true; ac.abort(); },
    async next(pred, ms = 5000) {
      const found = () => client.events.find(e => !e.taken && pred(e));
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = found(); if (hit) { hit.taken = true; return hit; }
        if (Date.now() > deadline) throw new Error(`timeout waiting for event; saw ${JSON.stringify(client.events.map(e => e.event))}`);
        await new Promise(r => { client.waiters.push(r); setTimeout(r, 50); });
      }
    },
    names: () => client.events.map(e => e.event) };
  app.open.add(client);
  if (res.ok && res.body) {
    (async () => {
      const dec = new TextDecoder(); let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            let event = 'message', data = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith(':')) event = line.trim();
              else if (line.startsWith('event:')) event = line.slice(6).trim();
              else if (line.startsWith('data:')) data.push(line.slice(5).trim());
            }
            let parsed; try { parsed = data.length ? JSON.parse(data.join('\n')) : undefined; } catch { parsed = data.join('\n'); }
            client.events.push({ event, data: parsed, at: Date.now() });
            for (const w of client.waiters.splice(0)) w();
          }
        }
      } catch { /* aborted */ }
      client.closed = true;
    })();
  } else { await res.body?.cancel().catch(() => {}); }
  return client;
}

// POST /api/call/speak. Returns {status, headers, events (NDJSON), raw, json}.
export async function speak(app, as, { t = TOKEN, body = AUDIO, type = 'audio/webm', headers = {}, signal } = {}) {
  const res = await fetch(url(app.base, '/api/call/speak', { as, t }), { method: 'POST', headers: type ? { 'Content-Type': type, ...headers } : headers, body, signal });
  const raw = await res.text();
  let events = [], json;
  if ((res.headers.get('content-type') || '').includes('ndjson')) events = raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  else { try { json = JSON.parse(raw); } catch { /* not json */ } }
  return { status: res.status, headers: res.headers, events, raw, json };
}
export const errorMessage = r => r.events.find(e => e.type === 'error')?.message ?? r.events.find(e => e.type === 'error')?.error ?? r.json?.error ?? r.json?.message;
export const idOf = r => r.events.map(e => e.id).find(Boolean);

// Fake providers for live-mode scenarios: Groq echoes the uploaded bytes as the transcript, Gemma echoes the
// transcript as the cleaned text, Twinly "renders" the text itself as the audio bytes, so a fetched clip tells you
// exactly which text was synthesised. Scenario hooks let tests inject failures.
export function fakeProviders(scenario = {}) {
  const state = { calls: [], speakPosts: 0, activeByKey: {}, maxActiveByKey: {}, jobs: new Map(), speakKeys: [], maxActiveTotal: 0, active: 0 };
  const respond = (v) => v instanceof Response ? v : Response.json(v);
  const fetchImpl = async (input, init = {}) => {
    const u = String(input); const method = init.method || 'GET';
    state.calls.push(`${method} ${u}`);
    if (u.includes('groq.com')) {
      const file = init.body.get('file'); const text = await file.text();
      return Response.json({ text });
    }
    if (u.includes('generativelanguage')) {
      const body = JSON.parse(init.body); const prompt = body.contents[0].parts[0].text;
      const text = JSON.parse(prompt.slice(prompt.lastIndexOf('Transcript (JSON string):\n') + 'Transcript (JSON string):\n'.length));
      if (scenario.google) { const r = await scenario.google(text); if (r) return respond(r); }
      return Response.json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    }
    const key = (init.headers?.Authorization || '').replace('Bearer ', '');
    if (method === 'POST' && u.includes('/voice/speak')) {
      state.speakPosts++; state.speakKeys.push(key);
      if (scenario.speak) { const r = await scenario.speak(state, key, init); if (r) return respond(r); }
      const id = 'job-' + state.speakPosts; const text = JSON.parse(init.body).text;
      state.jobs.set(id, { text, key });
      state.activeByKey[key] = (state.activeByKey[key] || 0) + 1; state.active++;
      state.maxActiveByKey[key] = Math.max(state.maxActiveByKey[key] || 0, state.activeByKey[key]);
      state.maxActiveTotal = Math.max(state.maxActiveTotal, state.active);
      return Response.json({ id, status: 'queued' }, { status: 202 });
    }
    const m = /\/jobs\/([^/?]+)(\/cancel)?/.exec(u);
    if (m) {
      if (scenario.job) { const r = await scenario.job(state, m[1]); if (r) return respond(r); }
      const job = state.jobs.get(m[1]);
      if (!job) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      if (m[2]) return Response.json({ id: m[1], status: 'canceled' });
      await delay(scenario.renderMs ?? 120);
      state.activeByKey[job.key]--; state.active--;
      return Response.json({ id: m[1], status: 'done', result: { audio_b64: Buffer.from(job.text).toString('base64'), mime: 'audio/mp4', seconds: 1 } });
    }
    return new Response('unexpected ' + u, { status: 500 });
  };
  return { fetchImpl, state };
}

export const LIVE_ENV = { APP_MODE: 'live', TTS_PROVIDER: 'twinly', GROQ_API_KEY: GROQ, GOOGLE_API_KEY: GOOGLE,
  TWINLY_API_KEY_ARYAN: KEY_ARYAN, TWINLY_API_KEY_ROHIT: KEY_ROHIT, MAX_RETRIES: '0', REQUEST_TIMEOUT_MS: '4000' };

export async function clipText(app, ev, t = TOKEN) {
  const r = await fetch(app.base + ev.data.url + (ev.data.url.includes('?') ? '&' : '?') + 't=' + t);
  return { status: r.status, text: Buffer.from(await r.arrayBuffer()).toString(), type: r.headers.get('content-type') };
}
