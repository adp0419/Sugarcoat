import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamPlayer } from '../public/playback.js';

function setup() {
  const buffers = [], sources = [], controller = new AbortController();
  const context = {
    state: 'running', currentTime: 0, baseLatency: 0,
    createBuffer(_channels, length, rate) {
      const samples = new Float32Array(length);
      const buffer = { samples, duration: length / rate, getChannelData: () => samples };
      buffers.push(buffer); return buffer;
    },
    createBufferSource() {
      const source = { connect() {}, disconnect() {}, start(at) { this.at = at; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
    async decodeAudioData(bytes) { this.decoded = bytes; return { duration: 0.1 }; },
  };
  const player = new StreamPlayer(context, controller.signal, () => {}, () => { throw new Error('Unexpected playback gate'); });
  return { buffers, sources, controller, context, player };
}

test('streamed PCM handles odd network boundaries and signed little-endian samples', async () => {
  const { player, buffers, controller } = setup();
  player.setFormat({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await player.push(Buffer.from([0]).toString('base64'));
  assert.equal(buffers.length, 0);
  await player.push(Buffer.from([128, 255, 127]).toString('base64'));
  assert.deepEqual([...buffers[0].samples], [-1, 32767 / 32768]);
  controller.abort();
});
test('playback completion waits for the final source to finish', async () => {
  const { player, sources, controller } = setup();
  player.setFormat({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await player.push(Buffer.alloc(2400).toString('base64'));
  let finished = false;
  const promise = player.finish().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  sources[0].onended(); await promise;
  assert.equal(finished, true); controller.abort();
});
test('Stop kills queued sources and rejects pending completion', async () => {
  const { player, sources, controller } = setup();
  player.setFormat({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await player.push(Buffer.alloc(2400).toString('base64'));
  await player.push(Buffer.alloc(2400).toString('base64'));
  const completion = player.finish();
  controller.abort(new DOMException('Canceled', 'AbortError'));
  await assert.rejects(completion, { name: 'AbortError' });
  assert.ok(sources.every(source => source.stopped)); assert.equal(player.nodes.size, 0);
});
test('compressed audio buffers until EOF and then decodes once', async () => {
  const { player, sources, controller, context } = setup();
  player.setFormat({ encoding: 'encoded', mimeType: 'audio/mpeg' });
  await player.push(Buffer.from([1, 2]).toString('base64'));
  await player.push(Buffer.from([3, 4]).toString('base64'));
  assert.equal(sources.length, 0);
  const completion = player.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...new Uint8Array(context.decoded)], [1, 2, 3, 4]);
  sources[0].onended(); await completion; controller.abort();
});
test('malformed PCM never silently drops the last byte', async () => {
  const { player, controller } = setup();
  player.setFormat({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await player.push(Buffer.from([1]).toString('base64'));
  await assert.rejects(player.finish(), /incomplete PCM/); controller.abort();
});

test('replay Blob preserves encoded audio without a second synthesis request', async () => {
  const { player, controller } = setup();
  player.setFormat({ encoding: 'encoded', mimeType: 'audio/mp4' });
  await player.push(Buffer.from([1, 2, 3, 4]).toString('base64'));
  const blob = player.audioBlob();
  assert.equal(blob.type, 'audio/mp4');
  controller.abort(); // Blob remains usable even if initial playback is stopped.
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4]);
});
test('mock PCM replay has a valid WAV header and original samples', async () => {
  const { player, controller } = setup();
  player.setFormat({ encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 });
  await player.push(Buffer.from([1, 2, 3, 4]).toString('base64'));
  const blob = player.audioBlob(), bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav'); assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt32LE(24), 24000); assert.equal(bytes.readUInt32LE(40), 4);
  assert.deepEqual([...bytes.subarray(44)], [1, 2, 3, 4]); controller.abort();
});
