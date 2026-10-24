import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { readConfig } from './lib/config.mjs';
import { AppError } from './lib/http.mjs';
import { preClean } from './lib/cleanup.mjs';
import { AUDIO_TYPES, transcribe, cleanWithGoogle } from './lib/providers.mjs';
import { loadTts, validateAudio } from './lib/tts/index.mjs';

const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/playback.js', ['public/playback.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
]);

function readAudio(req, limit, signal) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const finish = (error) => {
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (error) { req.resume(); reject(error); } else resolve(Buffer.concat(chunks, size));
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) finish(new AppError('Recording is too large. Try a shorter utterance.', 413, 'AUDIO_LIMIT'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(size ? null : new AppError('No audio was received.', 400, 'EMPTY_AUDIO'));
    const onError = error => finish(error);
    const onAbort = () => finish(signal.reason);
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function createApp(config = readConfig(), { fetchImpl, synthesize: injectedTts, logger = console } = {}) {
  const synthesize = injectedTts || await loadTts(config, { fetchImpl });
  let active = 0, sequence = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Permissions-Policy', 'microphone=(self)');
    const json = (status, data) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const path = req.url?.split('?')[0];
    if (req.method === 'GET' && path === '/api/config') {
      json(200, { mode: config.mode, tts: config.ttsProvider, maxAudioBytes: config.maxAudioBytes,
        maxRecordSeconds: config.maxRecordSeconds, vadSilenceMs: config.vadSilenceMs,
        vadThreshold: config.vadThreshold, timeoutMs: config.timeoutMs });
      return;
    }
    if (req.method === 'GET' && path === '/healthz') { json(200, { ok: true }); return; }
    if (req.method === 'GET' && files.has(path)) {
      try {
        const [name, type] = files.get(path);
        const body = await readFile(new URL(name, import.meta.url));
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length }); res.end(body);
      } catch { json(500, { error: 'Could not load application.' }); }
      return;
    }
    if (path !== '/api/process') { json(404, { error: 'Not found.' }); return; }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); json(405, { error: 'Use POST.' }); return; }
    const expectedOrigin = config.origin || `http://${req.headers.host}`;
    if ((req.headers.origin && req.headers.origin !== expectedOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
      req.resume(); json(403, { error: 'Use the application from its configured origin.' }); return;
    }
    if (active >= config.maxConcurrent) {
      req.resume(); res.setHeader('Retry-After', '1'); json(429, { error: 'Server is busy. Retry in a moment.' }); return;
    }
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(type)) { req.resume(); json(415, { error: 'Unsupported recording format.' }); return; }
    if (Number(req.headers['content-length']) > config.maxAudioBytes) {
      req.resume(); json(413, { error: 'Recording is too large.' }); return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const disconnected = () => { if (!res.writableEnded) controller.abort(new Error('Client disconnected')); };
    res.once('close', disconnected);
    req.once('aborted', disconnected);
    const timer = setTimeout(() => controller.abort(new AppError('Request timed out. Try a shorter utterance.', 504, 'TIMEOUT')), config.timeoutMs);
    const start = performance.now();
    const id = ++sequence;
    const timings = { receiveMs: null, sttMs: null, rulesMs: null, llmFirstTokenMs: null,
      llmMs: null, ttsFirstByteMs: null, ttsStreamMs: null, serverTotalMs: null };
    let stage = 'receive', stageStart = start;
    active++;
    const send = async (type, data = {}) => {
      signal.throwIfAborted();
      if (!res.write(JSON.stringify({ type, ...data }) + '\n')) await once(res, 'drain', { signal });
    };
    const measure = async (name, action) => {
      stage = name; stageStart = performance.now();
      try { return await action(); } finally { timings[`${name}Ms`] = performance.now() - stageStart; }
    };
    try {
      if (config.mode === 'live' && (!config.groqKey || !config.googleKey)) {
        throw new AppError('Live mode requires GROQ_API_KEY and GOOGLE_API_KEY on the server.', 503, 'MISSING_KEYS');
      }
      if (config.ttsProvider === 'twinly' && !config.twinlyKey) {
        throw new AppError('Set TWINLY_API_KEY on the server to enable Twinly cloned voice playback.', 503, 'TWINLY_NOT_CONFIGURED');
      }
      const audio = await measure('receive', () => readAudio(req, config.maxAudioBytes, signal));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store, no-transform' });
      res.flushHeaders();
      await send('status', { stage: 'transcribing' });
      const transcript = await measure('stt', () => transcribe(audio, type, config, signal, fetchImpl));
      const text = await measure('rules', () => preClean(transcript));
      await send('status', { stage: 'cleaning', timings });
      const cleaned = text ? await measure('llm', () => cleanWithGoogle(text, config, signal,
        preview => send('preview', { text: preview }), timings, fetchImpl)) : '';
      await send('cleaned', { text: cleaned, timings });
      if (cleaned) {
        stage = 'ttsStream'; stageStart = performance.now();
        const result = await synthesize({ text: cleaned, voiceId: config.voiceId,
          apiKey: config.twinlyKey, signal, onStatus: stage => send('status', { stage, timings }) });
        validateAudio(result);
        await send('format', { format: result.format });
        let size = 0;
        for await (const bytes of result.stream) {
          signal.throwIfAborted();
          if (!(bytes instanceof Uint8Array)) throw new AppError('TTS adapter returned invalid audio bytes.');
          if (!bytes.byteLength) continue;
          if (timings.ttsFirstByteMs === null) timings.ttsFirstByteMs = performance.now() - stageStart;
          size += bytes.byteLength;
          if (size > config.maxTtsBytes) throw new AppError('TTS audio exceeded the size limit.');
          for (let offset = 0; offset < bytes.byteLength; offset += 12288) {
            await send('audio', { data: Buffer.from(bytes.subarray(offset, offset + 12288)).toString('base64'), timings });
          }
        }
        if (!size) throw new AppError('TTS returned no audio.');
        timings.ttsStreamMs = performance.now() - stageStart;
      }
      timings.serverTotalMs = performance.now() - start;
      await send('done', { timings });
      res.end();
      logger.info(JSON.stringify({ id, outcome: 'ok', timings }));
    } catch (caught) {
      const error = signal.aborted ? signal.reason : caught;
      if (timings[`${stage}Ms`] === null) timings[`${stage}Ms`] = performance.now() - stageStart;
      timings.serverTotalMs = performance.now() - start;
      const message = error instanceof AppError ? error.message : 'Processing failed. Try again.';
      if (!res.destroyed && !res.writableEnded) {
        const payload = { error: message, code: error.code || 'PROCESSING_ERROR', timings, retryAfter: error.retryAfter };
        if (res.headersSent) res.end(JSON.stringify({ type: 'error', ...payload }) + '\n');
        else { req.resume(); if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter)); json(error.status || 500, payload); }
      }
      logger.info(JSON.stringify({ id, outcome: signal.aborted ? 'aborted' : 'error', code: error.code || 'PROCESSING_ERROR', stage, timings }));
    } finally {
      clearTimeout(timer);
      controller.abort(); // Also terminate provider work after an error or completion.
      res.off('close', disconnected); req.off('aborted', disconnected);
      active--;
    }
  });
  server.requestTimeout = config.timeoutMs + 5000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 65000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = readConfig();
  const server = await createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(`VoiceFlow Lite · ${config.mode} · TTS ${config.ttsProvider}\nLocal: http://${config.host}:${server.address().port}`);
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => {
    server.close(); server.closeAllConnections();
  });
}
