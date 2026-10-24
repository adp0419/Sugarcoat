// Browser verification only: real MediaRecorder and playback, synthetic microphone,
// mock providers. This server never reads .env or calls external providers.
// Run: node scripts/preview-ui.mjs, then open http://127.0.0.1:3011.
// Optional query scenarios: ?mic=denied, ?mic=slow, ?audio=blocked,
// ?response=error, ?response=slow, ?response=interrupted, ?config=offline.
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';

const backend = await createApp(readConfig({ APP_MODE: 'mock', TTS_PROVIDER: 'mock', PORT: '0' }));
backend.listen(0, '127.0.0.1');
await once(backend, 'listening');
const backendPort = backend.address().port;
let uploads = 0;

const fixture = `
const scenario = new URLSearchParams(location.search);
const nativeFetch = window.fetch;
window.fetch = (input, options) => {
  const url = new URL(input, location.origin);
  for (const name of ['response', 'config']) {
    if (scenario.has(name)) url.searchParams.set(name, scenario.get(name));
  }
  return nativeFetch(url, options);
};
const NativeAudioContext = window.AudioContext;
if (scenario.get('audio') === 'blocked') {
  window.AudioContext = class extends NativeAudioContext {
    attempts = 0;
    resume() { return ++this.attempts === 1 ? super.suspend() : super.resume(); }
  };
}
let micAttempts = 0;
navigator.mediaDevices.getUserMedia = async () => {
  if (scenario.get('mic') === 'denied' && ++micAttempts === 1) {
    throw new DOMException('Synthetic permission denial', 'NotAllowedError');
  }
  if (scenario.get('mic') === 'slow') await new Promise(resolve => setTimeout(resolve, 1000));
  const ctx = new NativeAudioContext();
  const destination = ctx.createMediaStreamDestination();
  const oscillator = ctx.createOscillator();
  oscillator.frequency.value = 220;
  oscillator.connect(destination); oscillator.start(); await ctx.resume();
  for (const track of destination.stream.getTracks()) {
    const stop = track.stop.bind(track);
    track.stop = () => { stop(); oscillator.stop(); ctx.close(); };
  }
  return destination.stream;
};
`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/browser-fixture.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(fixture); return;
  }
  if (url.pathname === '/') {
    const response = await fetch(`http://127.0.0.1:${backendPort}/`);
    const html = (await response.text()).replace('<script type="module"', '<script src="/browser-fixture.js"></script>\n  <script type="module"');
    res.writeHead(200, { ...Object.fromEntries(response.headers), 'content-length': Buffer.byteLength(html) });
    res.end(html); return;
  }
  if (url.pathname === '/api/config' && url.searchParams.get('config') === 'offline') {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return;
  }
  if (url.pathname === '/api/process') {
    console.log(`Browser fixture upload ${++uploads}: ${req.headers['content-type']}`);
    if (url.searchParams.get('response') === 'error') {
      req.resume(); res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server is busy. Retry in a moment.' })); return;
    }
    if (url.searchParams.get('response') === 'interrupted') {
      req.resume(); res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ type: 'status', stage: 'cleaning' }) + '\n'); return;
    }
    if (url.searchParams.get('response') === 'slow') await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (res.destroyed) { req.resume(); return; }
  // The backend's same-origin guard remains active under the proxy.
  const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` };
  if (headers.origin) headers.origin = `http://127.0.0.1:${backendPort}`;
  const upstream = http.request({ host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});
server.listen(3011, '127.0.0.1');
await once(server, 'listening');
console.log('Synthetic microphone preview: http://127.0.0.1:3011 (mock only)');
const close = () => { server.close(); backend.close(); };
process.once('SIGINT', close); process.once('SIGTERM', close);
