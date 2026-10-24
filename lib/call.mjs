// Two-person call room. STUB: contract-shaped mock data so the call page,
// simulator and QA can build against it. Replaced by the real pipeline next.
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(String(value)).digest();
const tokenOk = (given, expected) => timingSafeEqual(digest(given), digest(expected));

function wav(seconds = 0.5, rate = 8000) {
  const n = Math.round(seconds * rate), out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  return out;
}

export function createCall(config) {
  const people = config.callParticipants;
  const streams = new Map(people.map(name => [name, new Set()]));
  const peerOf = name => people.find(other => other !== name);
  const emit = (name, event, data) => {
    for (const res of streams.get(name)) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ping = setInterval(() => { for (const set of streams.values()) for (const res of set) res.write(':ping\n\n'); }, 15000);
  ping.unref();

  return async function handle(req, res, path) {
    if (!path.startsWith('/api/call/')) return false;
    const url = new URL(req.url, 'http://x');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!config.callToken) { req.resume(); send(503, { error: 'Set CALL_TOKEN on the server to enable calls.', code: 'CALL_NOT_CONFIGURED' }); return true; }
    if (!tokenOk(url.searchParams.get('t') || '', config.callToken)) { req.resume(); send(401, { error: 'Invalid call token.', code: 'BAD_TOKEN' }); return true; }
    const clip = /^\/api\/call\/clip\/([\w-]+)$/u.exec(path);
    if (req.method === 'GET' && clip) {
      const body = wav();
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length }); res.end(body); return true;
    }
    const as = url.searchParams.get('as');
    if (!people.includes(as)) { req.resume(); send(400, { error: 'Unknown participant.', code: 'BAD_NAME' }); return true; }
    const peer = peerOf(as);
    if (req.method === 'GET' && path === '/api/call/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      streams.get(as).add(res);
      res.write(`event: hello\ndata: ${JSON.stringify({ you: as, peer, peerOnline: streams.get(peer).size > 0 })}\n\n`);
      emit(peer, 'presence', { peer: as, online: true });
      res.on('close', () => {
        streams.get(as).delete(res);
        if (!streams.get(as).size) emit(peer, 'presence', { peer: as, online: false });
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/call/speak') {
      req.resume();
      const id = randomUUID();
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store, no-transform' });
      const line = o => res.write(JSON.stringify(o) + '\n');
      line({ type: 'status', stage: 'transcribing' }); line({ type: 'status', stage: 'cleaning' });
      line({ type: 'preview', text: 'Stub: hello from ' + as }); line({ type: 'cleaned', text: 'Stub: hello from ' + as });
      emit(peer, 'caption', { id, from: as, text: 'Stub: hello from ' + as });
      emit(peer, 'clip', { id, from: as, seq: 0, of: 1, mime: 'audio/wav', url: `/api/call/clip/${id}-0`, seconds: 0.5 });
      line({ type: 'done', id }); res.end(); return true;
    }
    if (req.method === 'POST' && path === '/api/call/ack') {
      let body = ''; for await (const chunk of req) body += chunk;
      let id; try { id = JSON.parse(body).id; } catch { /* ignore */ }
      if (typeof id === 'string') emit(peer, 'delivered', { id });
      send(200, { ok: true }); return true;
    }
    send(404, { error: 'Not found.' }); return true;
  };
}
