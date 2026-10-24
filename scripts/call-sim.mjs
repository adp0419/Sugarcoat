// Headless two-person call simulator: Aryan and Rohit as Node clients (built-ins only).
// Usage: node scripts/call-sim.mjs [--url http://localhost:3000] [--token T] [--rounds N] [--seq-base 1] [--timeout ms]
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const base = flag('url', process.env.CALL_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = flag('token', process.env.CALL_TOKEN || '');
const rounds = Math.max(1, Number(flag('rounds', 1)) || 1);
const seqBase = Number(flag('seq-base', 1)); // contract says seq runs 1..of
const WAIT_MS = Number(flag('timeout', 30000));

const names = ['aryan', 'rohit'];
const q = (as, t = token) => `as=${encodeURIComponent(as)}&t=${encodeURIComponent(t)}`;

// 1 s of 440 Hz mono 16-bit 16 kHz WAV, generated in memory.
function makeWav(seconds = 1, rate = 16000) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return buf;
}

// Minimal SSE client. Collects events with a receive timestamp; supports waiting for a predicate.
class Sse {
  constructor(as) { this.as = as; this.events = []; this.waiters = []; this.controller = new AbortController(); }
  async open() {
    const res = await fetch(`${base}/api/call/events?${q(this.as)}`, {
      headers: { Accept: 'text/event-stream' }, signal: this.controller.signal });
    if (res.status !== 200) throw new Error(`SSE ${this.as}: HTTP ${res.status}`);
    this.pump(res.body);
    await this.wait(e => e.event === 'hello', 'hello');
  }
  async pump(body) {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let event = 'message'; const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (!data.length) continue;
          let payload; try { payload = JSON.parse(data.join('\n')); } catch { payload = { raw: data.join('\n') }; }
          this.events.push({ event, data: payload, at: performance.now() });
          this.waiters = this.waiters.filter(w => !w.check());
        }
      }
    } catch (e) { if (e.name !== 'AbortError') this.error = e; }
  }
  // Resolve with the first event after `from` index matching the predicate.
  wait(pred, label, from = 0) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error(`${this.as}: timed out waiting for ${label}`));
      }, WAIT_MS);
      const waiter = { check: () => {
        const hit = this.events.slice(from).find(pred);
        if (hit) { clearTimeout(timer); resolve(hit); return true; }
        return false;
      } };
      if (!waiter.check()) this.waiters.push(waiter);
    });
  }
  close() { this.controller.abort(); }
}

function parseNdjson() {
  let buf = '';
  return chunk => {
    buf += chunk; const out = [];
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) out.push(JSON.parse(l)); }
    return out;
  };
}

const failures = [];
const check = (cond, message) => { if (!cond) { failures.push(message); console.error(`  FAIL: ${message}`); } else console.log(`  ok:   ${message}`); };

async function expectStatus(label, url, init, status) {
  try { const r = await fetch(url, init); await r.arrayBuffer(); check(r.status === status, `${label} -> ${r.status} (want ${status})`); }
  catch (e) { check(false, `${label}: ${e.message}`); }
}

async function direction(from, to, streams, wav, round) {
  console.log(`\nround ${round}: ${from} -> ${to}`);
  const rx = streams[to], tx = streams[from];
  const rxFrom = rx.events.length, txFrom = tx.events.length;
  const t0 = performance.now();
  const res = await fetch(`${base}/api/call/speak?${q(from)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  check(res.status === 200, `speak HTTP ${res.status}`);
  const msgs = [];
  const parse = parseNdjson(); const dec = new TextDecoder();
  if (res.body) for await (const c of res.body) msgs.push(...parse(dec.decode(c, { stream: true })));
  const types = msgs.map(m => m.type);
  const ci = types.indexOf('cleaned'), di = types.indexOf('done');
  check(ci >= 0 && di > ci, `sender NDJSON has cleaned then done (${types.join(',')})`);
  check(!types.includes('error'), 'sender NDJSON has no error');
  check(!types.includes('audio') && !msgs.some(m => m.data && m.type !== 'status'), 'sender stream carries no audio');
  if (types.includes('error')) throw new Error(`speak error: ${msgs.find(m => m.type === 'error').message || JSON.stringify(msgs.find(m => m.type === 'error'))}`);

  const caption = await rx.wait(e => e.event === 'caption', 'caption', rxFrom);
  check(caption.data.from === from && typeof caption.data.text === 'string' && caption.data.text.length > 0, `peer caption from ${from}: "${caption.data.text}"`);
  const firstClip = await rx.wait(e => e.event === 'clip' && e.data.id === caption.data.id, 'first clip', rxFrom);
  const of = firstClip.data.of;
  await rx.wait(e => e.event === 'clip' && e.data.id === caption.data.id && e.data.seq === of - 1 + seqBase, `last clip (${of} total)`, rxFrom);
  const clips = rx.events.slice(rxFrom).filter(e => e.event === 'clip' && e.data.id === caption.data.id);
  const seqs = clips.map(e => e.data.seq);
  check(seqs.join() === Array.from({ length: of }, (_, i) => i + seqBase).join(), `clips arrive in order seq ${seqs.join(',')} of ${of} (expect base ${seqBase})`);
  check(rx.events.slice(rxFrom).indexOf(caption) < rx.events.slice(rxFrom).indexOf(clips[0]), 'caption arrives before first clip');
  for (const c of clips) {
    const url = new URL(c.data.url, base + '/');
    if (!url.searchParams.has('t')) url.searchParams.set('t', token);
    const r = await fetch(url);
    const bytes = (await r.arrayBuffer()).byteLength;
    check(r.status === 200 && bytes > 0, `clip ${c.data.seq} fetch ${r.status}, ${bytes} bytes`);
  }

  const a0 = performance.now();
  const ack = await fetch(`${base}/api/call/ack?${q(to)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: caption.data.id }) });
  await ack.arrayBuffer();
  check(ack.status < 300, `ack HTTP ${ack.status}`);
  const delivered = await tx.wait(e => e.event === 'delivered' && e.data.id === caption.data.id, 'delivered', txFrom);
  check(!!delivered, 'sender got delivered');
  return { dir: `${from}->${to}`, caption: caption.at - t0, clip: firstClip.at - t0, delivered: delivered.at - t0, ack: a0 - t0 };
}

async function main() {
  console.log(`call-sim against ${base} (rounds=${rounds})`);
  if (!token) console.log('note: no --token / CALL_TOKEN given; expecting a server that needs none or failing 401');
  console.log('\nauth checks');
  const wav = makeWav();
  await expectStatus('wrong token on events', `${base}/api/call/events?${q('aryan', 'definitely-wrong')}`, {}, 401);
  await expectStatus('missing token on events', `${base}/api/call/events?as=aryan`, {}, 401);
  await expectStatus('wrong token on speak', `${base}/api/call/speak?${q('aryan', 'definitely-wrong')}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }, 401);
  await expectStatus('unknown name on events', `${base}/api/call/events?${q('mallory')}`, {}, 400);
  await expectStatus('unknown name on speak', `${base}/api/call/speak?${q('mallory')}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }, 400);

  const streams = Object.fromEntries(names.map(n => [n, new Sse(n)]));
  const rows = [];
  try {
    await Promise.all(names.map(n => streams[n].open()));
    console.log('\nboth SSE streams open (hello received)');
    for (let r = 1; r <= rounds; r++) {
      rows.push(await direction('aryan', 'rohit', streams, wav, r));
      rows.push(await direction('rohit', 'aryan', streams, wav, r));
    }
  } catch (e) { failures.push(e.message); console.error(`  FAIL: ${e.message}`); }
  finally { names.forEach(n => streams[n].close()); }

  if (rows.length) {
    console.log('\ntiming (ms from POST start)');
    console.log('direction        caption  firstClip  delivered');
    for (const r of rows) console.log(`${r.dir.padEnd(15)} ${r.caption.toFixed(0).padStart(8)} ${r.clip.toFixed(0).padStart(10)} ${r.delivered.toFixed(0).padStart(10)}`);
  }
  console.log(failures.length ? `\nFAILED: ${failures.length} problem(s)` : '\nPASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
