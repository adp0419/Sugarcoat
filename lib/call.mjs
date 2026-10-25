// Two-person call room: SSE hub, in-memory clip store, per-key serial render
// queue and the speak pipeline. It composes the existing pipeline functions;
// it does not change them.
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { AppError } from './http.mjs';
import { preClean } from './cleanup.mjs';
import { AUDIO_TYPES, transcribe, cleanWithGoogle } from './providers.mjs';
import { loadTts, validateAudio } from './tts/index.mjs';
import { createTwinlyAdapter } from './tts/twinly.mjs';

const TWINLY_LINE_LIMIT = 600;
const digest = value => createHash('sha256').update(String(value)).digest();
const tokenOk = (given, expected) => timingSafeEqual(digest(given), digest(expected));
const first = value => String(value || '').split(',')[0].trim();

// Sentence-aware chunks of at most `max` characters, in order.
export function splitForTts(text, max = TWINLY_LINE_LIMIT) {
  const sentences = text.trim().split(/(?<=[.!?…。！？])\s+/u).filter(Boolean);
  const out = [];
  let current = '';
  for (let sentence of sentences) {
    while (sentence.length > max) {
      if (current) { out.push(current); current = ''; }
      let cut = sentence.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      out.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (!sentence) continue;
    if (current && current.length + 1 + sentence.length > max) { out.push(current); current = ''; }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) out.push(current);
  return out;
}

function wavFromPcm(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Exact for PCM/WAV; a speech-rate estimate for other encodings.
function secondsOf(bytes, mime, text) {
  if (mime === 'audio/wav' && bytes.length > 44 && bytes.toString('latin1', 0, 4) === 'RIFF') {
    const byteRate = bytes.readUInt32LE(28);
    if (byteRate) return Math.round((bytes.length - 44) / byteRate * 10) / 10;
  }
  return Math.round(text.length / 15 * 10) / 10;
}

export function createCall(config, {
  fetchImpl, synthesize: injected, logger = console, now = Date.now,
  clipTtlMs = 10 * 60 * 1000, clipMaxBytes = 64 * 1024 * 1024, heartbeatMs = 15000, lineTimeoutMs = 120000,
  pollHoldMs = 25000, pollGraceMs = 15000,
} = {}) {
  const people = config.callParticipants || ['aryan', 'rohit'];
  const peerOf = name => people.find(other => other !== name);
  const keyFor = name => config.callKeys?.[name] || config.twinlyKey || '';
  const room = new Map(people.map(name => [name, { conns: new Set(), log: [], nextId: 1, waiters: new Set(), polling: 0, polledAt: -Infinity, announced: false, inVoice: false }]));
  // A person is online while an SSE stream is open or they are long-polling
  // (a poll is pending, or one ended within the grace window).
  const online = name => {
    const person = room.get(name);
    return person.conns.size > 0 || person.polling > 0 || now() - person.polledAt < pollGraceMs;
  };

  // --- SSE hub ------------------------------------------------------------
  const write = (res, frame) => {
    if (res.destroyed || res.writableEnded) return;
    try { res.write(frame); } catch { /* the close handler removes it */ }
  };
  function publish(name, event, data) {
    const person = room.get(name), id = person.nextId++;
    const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (event !== 'presence') { person.log.push({ id, event, data, frame }); if (person.log.length > 100) person.log.shift(); }
    for (const res of person.conns) write(res, frame);
    for (const wake of person.waiters) wake();
    logger.info(JSON.stringify({ call: 'publish', to: name, event, id, conns: person.conns.size }));
  }
  function syncPresence(name) {
    const person = room.get(name), state = online(name);
    if (state === person.announced) return;
    person.announced = state;
    publish(peerOf(name), 'presence', { peer: name, online: state });
    if (!state) setVoice(name, false);
  }
  // Voice channel: who has pressed "Join call". Only the UI uses it.
  function setVoice(name, value) {
    const person = room.get(name);
    if (person.inVoice === value) return;
    person.inVoice = value;
    publish(peerOf(name), 'voice', { peer: name, in: value });
  }
  const heartbeat = setInterval(() => {
    for (const person of room.values()) for (const res of person.conns) write(res, ':ping\n\n');
    for (const name of people) syncPresence(name);
  }, heartbeatMs);
  heartbeat.unref();

  // --- clip store (memory only) -------------------------------------------
  const clips = new Map();
  let clipBytes = 0;
  const dropClip = key => { const clip = clips.get(key); if (clip) { clipBytes -= clip.bytes.length; clips.delete(key); } };
  const sweep = () => { for (const [key, clip] of clips) if (clip.expires <= now()) dropClip(key); };
  const sweeper = setInterval(sweep, 30000);
  sweeper.unref();
  function putClip(key, bytes, mime) {
    sweep();
    if (bytes.length > clipMaxBytes) throw new AppError('Voice clip is too large to hold.', 502, 'CLIP_TOO_LARGE');
    while (clipBytes + bytes.length > clipMaxBytes) dropClip(clips.keys().next().value);
    clips.set(key, { bytes, mime, expires: now() + clipTtlMs });
    clipBytes += bytes.length;
  }
  const getClip = key => {
    const clip = clips.get(key);
    if (clip && clip.expires <= now()) { dropClip(key); return undefined; }
    return clip;
  };

  // --- messages awaiting an ack -------------------------------------------
  const messages = new Map();
  const noteMessage = (id, from) => {
    messages.set(id, { from, delivered: false, at: now() });
    for (const [key, message] of messages) {
      if (messages.size <= 500 && message.at + clipTtlMs * 3 > now()) break;
      messages.delete(key);
    }
  };

  // --- per-key serial queue and spend cap ---------------------------------
  const tails = new Map();
  function enqueue(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    const run = previous.then(task);
    const tail = run.then(() => {}, () => {});
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  }
  let linesUsed = 0, active = 0;

  const adapters = new Map();
  let defaultTts;
  async function synthFor(name) {
    if (injected) return injected;
    if (config.ttsProvider === 'twinly' && !config.adapterModule) {
      if (!adapters.has(name)) adapters.set(name, createTwinlyAdapter({ ...config, twinlyKey: keyFor(name) }, fetchImpl));
      return adapters.get(name);
    }
    return defaultTts ||= loadTts(config, { fetchImpl });
  }

  // --- helpers --------------------------------------------------------------
  function expectedOrigin(req) {
    // Behind a tunnel the forwarded host wins, so a stale APP_ORIGIN can't block calls.
    if (config.trustProxy && req.headers['x-forwarded-host']) {
      return `${first(req.headers['x-forwarded-proto']) || 'http'}://${first(req.headers['x-forwarded-host'])}`;
    }
    if (config.origin) return config.origin;
    if (config.trustProxy) return `${first(req.headers['x-forwarded-proto']) || 'http'}://${req.headers.host}`;
    return `http://${req.headers.host}`;
  }

  function readBody(req, limit, signal) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      const finish = error => {
        req.off('data', onData); req.off('end', onEnd); req.off('error', finish);
        signal?.removeEventListener('abort', onAbort);
        if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks, size));
      };
      const onData = chunk => {
        size += chunk.length;
        if (size > limit) finish(new AppError('Recording is too large. Try a shorter utterance.', 413, 'AUDIO_LIMIT'));
        else chunks.push(chunk);
      };
      const onEnd = () => finish(size ? null : new AppError('No audio was received.', 400, 'EMPTY_AUDIO'));
      const onAbort = () => finish(signal.reason);
      req.on('data', onData); req.once('end', onEnd); req.once('error', finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function render(name, text, signal, onStatus) {
    const synth = await synthFor(name);
    const result = await synth({ text, voiceId: config.voiceId, apiKey: keyFor(name), signal, onStatus });
    validateAudio(result);
    const parts = [];
    let size = 0;
    for await (const piece of result.stream) {
      signal.throwIfAborted();
      if (!(piece instanceof Uint8Array)) throw new AppError('TTS adapter returned invalid audio bytes.');
      size += piece.byteLength;
      if (size > config.maxTtsBytes) throw new AppError('TTS audio exceeded the size limit.');
      parts.push(piece);
    }
    if (!size) throw new AppError('TTS returned no audio.');
    let bytes = Buffer.concat(parts, size), mime;
    if (result.format.encoding === 'pcm_s16le') { bytes = wavFromPcm(bytes, result.format.sampleRate); mime = 'audio/wav'; }
    else mime = result.format.mimeType;
    return { bytes, mime, seconds: secondsOf(bytes, mime, text) };
  }

  // --- speak ----------------------------------------------------------------
  // voice=false is a voice message: same transcribe + cleanup, delivered as text, no Twinly.
  async function speak(req, res, as, peer, json, { voice = true } = {}) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(type)) { req.resume(); return json(415, { error: 'Unsupported recording format.' }); }
    if (Number(req.headers['content-length']) > config.maxAudioBytes) { req.resume(); return json(413, { error: 'Recording is too large.' }); }
    if (active >= config.maxConcurrent) { req.resume(); res.setHeader('Retry-After', '1'); return json(429, { error: 'Server is busy. Retry in a moment.' }); }
    if (config.mode === 'live' && (!config.groqKey || !config.googleKey)) {
      req.resume(); return json(503, { error: 'Live mode requires GROQ_API_KEY and GOOGLE_API_KEY on the server.', code: 'MISSING_KEYS' });
    }
    if (voice && config.ttsProvider === 'twinly' && !keyFor(as)) {
      req.resume(); return json(503, { error: `Set a Twinly key for ${as} on the server (TWINLY_API_KEY_${as.toUpperCase()} or TWINLY_API_KEY).`, code: 'TWINLY_NOT_CONFIGURED' });
    }
    if (!online(peer)) { req.resume(); return json(409, { error: `${peer} is not connected. Nothing was sent.`, code: 'PEER_OFFLINE' }); }
    if (voice && linesUsed >= config.callMaxLines) {
      req.resume(); return json(429, { error: 'Voice line budget for this server run is used up. Restart the server to reset it.', code: 'CALL_LINE_CAP' });
    }

    const id = randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); };
    res.once('close', disconnected);
    const timer = setTimeout(() => controller.abort(new AppError('Request timed out. Try a shorter utterance.', 504, 'TIMEOUT')), config.timeoutMs);
    const send = (kind, data = {}) => write(res, JSON.stringify({ type: kind, ...data }) + '\n');
    const timings = { llmFirstTokenMs: null };
    let captioned = false;
    active++;
    try {
      const audio = await readBody(req, config.maxAudioBytes, signal);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store, no-transform' });
      res.flushHeaders();
      send('status', { stage: 'transcribing' });
      // The raw words go back to the speaker only, so their page can show what Gemma changed.
      const raw = String(await transcribe(audio, type, config, signal, fetchImpl) || '').trim();
      const text = preClean(raw);
      send('status', { stage: 'cleaning', transcript: raw });
      const cleaned = text ? await cleanWithGoogle(text, config, signal, preview => send('preview', { text: preview }), timings, fetchImpl) : '';
      clearTimeout(timer);
      // From here the rendering outlives the sender's connection.
      res.off('close', disconnected);
      send('cleaned', { text: cleaned, id, raw });
      if (!cleaned) { send('done', { id, lines: 0 }); res.end(); return; }

      if (!online(peer)) throw new AppError(`${peer} disconnected. Nothing was sent.`, 409, 'PEER_OFFLINE');
      if (!voice) {
        publish(peer, 'message', { id, from: as, text: cleaned, at: now() });
        send('done', { id, lines: 0 }); res.end();
        logger.info(JSON.stringify({ call: 'message', id, from: as, outcome: 'ok' }));
        return;
      }
      noteMessage(id, as);
      publish(peer, 'caption', { id, from: as, text: cleaned });
      captioned = true;

      const chunks = splitForTts(cleaned);
      if (linesUsed + chunks.length > config.callMaxLines) {
        throw new AppError('Voice line budget for this server run is used up. The caption was sent without voice.', 429, 'CALL_LINE_CAP');
      }
      linesUsed += chunks.length;
      send('status', { stage: 'speaking', of: chunks.length });
      await enqueue(keyFor(as) || '(shared)', async () => {
        for (let seq = 0; seq < chunks.length; seq++) {
          const lineSignal = AbortSignal.timeout(lineTimeoutMs);
          const clip = await render(as, chunks[seq], lineSignal, stage => send('status', { stage }));
          const clipId = `${id}-${seq}`;
          putClip(clipId, clip.bytes, clip.mime);
          publish(peer, 'clip', { id, from: as, seq, of: chunks.length, mime: clip.mime, url: `/api/call/clip/${clipId}`, seconds: clip.seconds });
          send('status', { stage: 'sent', seq, of: chunks.length });
        }
      });
      send('done', { id, lines: chunks.length });
      res.end();
      logger.info(JSON.stringify({ call: 'speak', id, from: as, outcome: 'ok', lines: chunks.length }));
    } catch (caught) {
      const error = signal.aborted && !captioned ? signal.reason : caught;
      const message = error instanceof AppError ? error.message : 'Processing failed. Try again.';
      const code = error.code || 'PROCESSING_ERROR';
      if (captioned) publish(peer, 'error', { id, from: as, message });
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.end(JSON.stringify({ type: 'error', error: message, code }) + '\n');
        else { req.resume(); json(error.status || 500, { error: message, code }); }
      }
      logger.info(JSON.stringify({ call: 'speak', id, from: as, outcome: signal.aborted ? 'aborted' : 'error', code }));
    } finally {
      clearTimeout(timer);
      res.off('close', disconnected);
      active--;
    }
  }

  // --- routes -----------------------------------------------------------------
  return async function handleCall(req, res, path) {
    if (path !== '/api/call' && !path?.startsWith('/api/call/')) return false;
    const json = (status, data) => {
      if (res.destroyed || res.writableEnded || res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (!config.callToken) {
        req.resume(); json(503, { error: 'Calls are not enabled. Set CALL_TOKEN on the server.', code: 'CALL_NOT_CONFIGURED' }); return true;
      }
      const url = new URL(req.url, 'http://call.local');
      if (!tokenOk(url.searchParams.get('t') || '', config.callToken)) {
        req.resume(); json(401, { error: 'Invalid call token.', code: 'BAD_TOKEN' }); return true;
      }
      const origin = req.headers.origin;
      if ((origin && origin !== expectedOrigin(req)) || req.headers['sec-fetch-site'] === 'cross-site') {
        req.resume(); json(403, { error: 'Use the call page from its configured origin (set APP_ORIGIN, or TRUST_PROXY=true behind a tunnel).', code: 'BAD_ORIGIN' }); return true;
      }
      const allow = (method) => {
        if (req.method === method) return true;
        req.resume(); res.setHeader('Allow', method); json(405, { error: `Use ${method}.` }); return false;
      };

      const clipMatch = /^\/api\/call\/clip\/([A-Za-z0-9-]{1,80})$/u.exec(path);
      if (clipMatch) {
        if (!allow('GET')) return true;
        const clip = getClip(clipMatch[1]);
        logger.info(JSON.stringify({ call: 'clip-get', id: clipMatch[1], status: clip ? 200 : 404 }));
        if (!clip) { json(404, { error: 'Clip not found or expired.', code: 'CLIP_GONE' }); return true; }
        const { bytes, mime } = clip, total = bytes.length;
        const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
        const range = /^bytes=(\d*)-(\d*)$/u.exec(req.headers.range || '');
        if (range && (range[1] || range[2])) {
          let start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
          let end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
          if (start >= total || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return true;
          }
          res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
          res.end(bytes.subarray(start, end + 1)); return true;
        }
        res.writeHead(200, { ...headers, 'Content-Length': total }); res.end(bytes); return true;
      }

      const as = url.searchParams.get('as');
      if (!people.includes(as)) { req.resume(); json(400, { error: 'Unknown participant.', code: 'BAD_NAME' }); return true; }
      const peer = peerOf(as);

      if (path === '/api/call/events') {
        if (!allow('GET')) return true;
        const person = room.get(as);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        req.socket.setTimeout(0); req.socket.setNoDelay(true);
        person.conns.add(res);
        logger.info(JSON.stringify({ call: 'stream', as, state: 'open', conns: person.conns.size }));
        write(res, `retry: 2000\n\nevent: hello\ndata: ${JSON.stringify({ you: as, peer, peerOnline: online(peer) })}\n\n`);
        const lastId = Number(req.headers['last-event-id']);
        if (Number.isFinite(lastId)) for (const entry of person.log) if (entry.id > lastId) write(res, entry.frame);
        syncPresence(as);
        res.once('close', () => {
          person.conns.delete(res);
          logger.info(JSON.stringify({ call: 'stream', as, state: 'close', conns: person.conns.size }));
          syncPresence(as);
        });
        return true;
      }
      // Long-poll twin of /events for proxies that buffer SSE (cloudflared quick
      // tunnels hold the whole stream until it ends). `after` is the last event id
      // seen; without it the reply is just the current cursor.
      if (path === '/api/call/poll') {
        if (!allow('GET')) return true;
        const person = room.get(as);
        const raw = url.searchParams.get('after');
        let after = raw ? Number(raw) : NaN;
        if (after >= person.nextId) after = NaN; // cursor from an earlier server run: resync
        const pending = () => person.log.filter(entry => entry.id > after);
        person.polling++; person.polledAt = now(); syncPresence(as);
        if (Number.isFinite(after) && !pending().length) {
          await new Promise(resolve => {
            const finish = () => { clearTimeout(timer); person.waiters.delete(finish); res.off('close', finish); resolve(); };
            const timer = setTimeout(finish, pollHoldMs); timer.unref?.();
            person.waiters.add(finish); res.once('close', finish);
          });
        }
        person.polling--; person.polledAt = now();
        const events = Number.isFinite(after) ? pending().map(({ id, event, data }) => ({ id, event, data })) : [];
        json(200, { you: as, peer, peerOnline: online(peer), inVoice: person.inVoice, peerInVoice: room.get(peer).inVoice,
          cursor: person.nextId - 1, events });
        return true;
      }
      if (path === '/api/call/speak') {
        if (!allow('POST')) return true;
        await speak(req, res, as, peer, json); return true;
      }
      if (path === '/api/call/message') {
        if (!allow('POST')) return true;
        await speak(req, res, as, peer, json, { voice: false }); return true;
      }
      if (path === '/api/call/voice') {
        if (!allow('POST')) return true;
        let value;
        try { value = JSON.parse((await readBody(req, 1024)).toString('utf8')).in; } catch { /* handled below */ }
        if (typeof value !== 'boolean') { json(400, { error: 'Send {"in": true|false}.', code: 'BAD_VOICE' }); return true; }
        setVoice(as, value);
        json(200, { inVoice: value, peerInVoice: room.get(peer).inVoice }); return true;
      }
      if (path === '/api/call/ack') {
        if (!allow('POST')) return true;
        let id;
        try { id = JSON.parse((await readBody(req, 1024)).toString('utf8')).id; } catch { /* handled below */ }
        const message = typeof id === 'string' ? messages.get(id) : undefined;
        if (!message) { json(404, { error: 'Unknown message.', code: 'UNKNOWN_MESSAGE' }); return true; }
        if (message.from === as) { json(400, { error: 'Only the receiving side can acknowledge.', code: 'BAD_ACK' }); return true; }
        if (!message.delivered) { message.delivered = true; publish(message.from, 'delivered', { id }); }
        json(200, { ok: true }); return true;
      }
      req.resume(); json(404, { error: 'Not found.' }); return true;
    } catch (caught) {
      logger.info(JSON.stringify({ call: 'route', outcome: 'error', code: caught?.code || 'INTERNAL' }));
      json(500, { error: 'Call request failed.' });
      return true;
    }
  };
}
