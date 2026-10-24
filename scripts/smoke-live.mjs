// Explicit live smoke check: uses provider quota and one Twinly voice job per invocation.
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { readConfig } from '../lib/config.mjs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath) throw new Error('Usage: npm run test:live -- /path/to/short-speech.wav [/path/to/output.m4a]');
const config = readConfig();
if (config.mode !== 'live' || config.ttsProvider !== 'twinly') throw new Error('Set APP_MODE=live and TTS_PROVIDER=twinly first.');
const server = await createApp(config, { logger: { info() {} } });
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/process`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: await readFile(inputPath),
    signal: AbortSignal.timeout(config.timeoutMs + 5000),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const failed = events.find(event => event.type === 'error');
  if (failed) throw new Error(failed.error);
  if (events.at(-1)?.type !== 'done') throw new Error('Pipeline did not finish.');
  const audio = Buffer.concat(events.filter(event => event.type === 'audio').map(event => Buffer.from(event.data, 'base64')));
  if (!audio.length) throw new Error('No synthesized audio returned.');
  if (outputPath) await writeFile(outputPath, audio, { mode: 0o600 });
  console.log(JSON.stringify({ cleaned: events.find(event => event.type === 'cleaned')?.text,
    format: events.find(event => event.type === 'format')?.format, audioBytes: audio.length,
    timings: events.at(-1).timings, outputPath: outputPath || null }, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
