import { setTimeout as delay } from 'node:timers/promises';

// Deliberately a test tone. This is neither speech nor a voice clone.
export async function synthesize({ signal }) {
  const sampleRate = 24000;
  return {
    format: { encoding: 'pcm_s16le', sampleRate, channels: 1 },
    stream: (async function* () {
      for (let chunk = 0; chunk < 20; chunk++) {
        signal.throwIfAborted();
        const pcm = Buffer.alloc(2400); // 50ms of mono PCM.
        for (let i = 0; i < 1200; i++) {
          const sample = chunk * 1200 + i;
          const envelope = Math.min(1, sample / 240, (24000 - sample) / 480);
          pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * sample / sampleRate) * 2500 * envelope), i * 2);
        }
        yield pcm;
        await delay(40, undefined, { signal });
      }
    })(),
  };
}
