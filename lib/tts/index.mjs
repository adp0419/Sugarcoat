import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../http.mjs';

export async function loadTts(config, { fetchImpl } = {}) {
  if (config.ttsProvider === 'twinly' && !config.adapterModule) {
    const { createTwinlyAdapter } = await import('./twinly.mjs');
    return createTwinlyAdapter(config, fetchImpl);
  }
  const module = config.ttsProvider === 'mock' ? await import('./mock.mjs')
    : config.adapterModule ? await import(pathToFileURL(resolve(config.adapterModule)).href)
      : await import('./twinly.mjs');
  if (typeof module.synthesize !== 'function') throw new Error('TTS adapter must export synthesize');
  return module.synthesize;
}

export function validateAudio(result) {
  const format = result?.format;
  if (!result?.stream?.[Symbol.asyncIterator]) throw new AppError('TTS adapter must return an async byte stream.');
  if (format?.encoding === 'pcm_s16le' && format.channels === 1 &&
      Number.isInteger(format.sampleRate) && format.sampleRate >= 8000 && format.sampleRate <= 48000) return;
  if (format?.encoding === 'encoded' && ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/webm'].includes(format.mimeType)) return;
  throw new AppError('TTS adapter returned an unsupported audio format.');
}
