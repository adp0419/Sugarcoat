import { performance } from 'node:perf_hooks';
import { AppError, providerFetch, sseData } from './http.mjs';
import { CLEANUP_INSTRUCTION, MOCK_TRANSCRIPT, MOCK_CLEANED } from './cleanup.mjs';

export const AUDIO_TYPES = new Map([
  ['audio/webm', 'webm'], ['audio/ogg', 'ogg'], ['audio/mp4', 'mp4'],
  ['audio/wav', 'wav'], ['audio/x-wav', 'wav'], ['audio/mpeg', 'mp3'],
  ['audio/flac', 'flac'],
]);

export async function transcribe(audio, type, config, signal, fetchImpl) {
  if (config.mode === 'mock') return MOCK_TRANSCRIPT;
  const response = await providerFetch('Groq', 'https://api.groq.com/openai/v1/audio/transcriptions', () => {
    const form = new FormData();
    form.set('file', new Blob([audio], { type }), `speech.${AUDIO_TYPES.get(type)}`);
    form.set('model', config.groqModel);
    form.set('response_format', 'json');
    form.set('temperature', '0');
    if (config.language) form.set('language', config.language);
    return { method: 'POST', headers: { Authorization: `Bearer ${config.groqKey}` }, body: form };
  }, config, signal, fetchImpl);
  const json = await response.json();
  if (typeof json.text !== 'string') throw new AppError('Groq returned an invalid transcript.');
  if (json.text.length > 6000) throw new AppError('Transcript is too long. Use a shorter recording.', 413, 'TRANSCRIPT_LIMIT');
  return json.text;
}

export async function cleanWithGoogle(text, config, signal, onPreview, timings, fetchImpl) {
  const start = performance.now();
  if (config.mode === 'mock') {
    timings.llmFirstTokenMs = 0;
    await onPreview(MOCK_CLEANED);
    return MOCK_CLEANED;
  }
  const response = await providerFetch('Google',
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.googleModel)}:${config.googleStream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    () => ({
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.googleKey },
      body: JSON.stringify({
        // Put the instruction in contents for compatibility with Gemma models.
        contents: [{ role: 'user', parts: [{ text: `${CLEANUP_INSTRUCTION}\n\nTranscript (JSON string):\n${JSON.stringify(text)}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: Math.min(4096, Math.max(256, Math.ceil(text.length * 0.9) + 128)),
          ...(config.thinkingConfig ? { thinkingConfig: config.thinkingConfig } : {}) },
      }),
    }), config, signal, fetchImpl);
  let output = '', finishReason;
  const accept = async frame => {
    if (frame.error || frame.promptFeedback?.blockReason) throw new AppError('Google could not clean this transcript.');
    const candidate = frame.candidates?.[0];
    if (candidate?.finishReason) finishReason = candidate.finishReason;
    const token = (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || '').join('');
    if (token) {
      if (config.googleStream && timings.llmFirstTokenMs === null) timings.llmFirstTokenMs = performance.now() - start;
      output += token;
      if (output.length > 12000) throw new AppError('Cleaned transcript exceeded the output limit.');
      await onPreview(output);
    }
  };
  if (config.googleStream) {
    for await (const data of sseData(response.body, signal)) {
      if (data === '[DONE]') continue;
      let frame;
      try { frame = JSON.parse(data); } catch { throw new AppError('Google returned an invalid stream.'); }
      await accept(frame);
    }
  } else {
    await accept(await response.json());
  }
  // Never voice a truncated, blocked, or interrupted completion.
  if (finishReason !== 'STOP') throw new AppError(`Google did not complete cleanup (${finishReason || 'interrupted stream'}). Try a shorter recording.`);
  return output.trim();
}
