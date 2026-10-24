export function readConfig(env = process.env) {
  const number = (name, fallback, min, max) => {
    const n = Number(env[name] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
    return n;
  };
  const mode = env.APP_MODE || 'mock';
  const ttsProvider = env.TTS_PROVIDER || 'mock';
  if (!['mock', 'live'].includes(mode)) throw new Error('APP_MODE must be mock or live');
  if (!['mock', 'twinly'].includes(ttsProvider)) throw new Error('TTS_PROVIDER must be mock or twinly');
  return {
    mode, ttsProvider, host: env.HOST || '127.0.0.1', port: number('PORT', 3000, 0, 65535),
    origin: env.APP_ORIGIN || '', groqKey: env.GROQ_API_KEY || '',
    groqModel: env.GROQ_MODEL || 'whisper-large-v3-turbo', language: env.STT_LANGUAGE ?? 'en',
    googleKey: env.GOOGLE_API_KEY || '', googleModel: env.GOOGLE_MODEL || 'gemma-4-26b-a4b-it',
    googleStream: env.GOOGLE_STREAM === 'true',
    thinkingConfig: env.GOOGLE_THINKING_CONFIG === '' ? undefined
      : JSON.parse(env.GOOGLE_THINKING_CONFIG || '{"thinkingLevel":"minimal"}'),
    adapterModule: env.TTS_ADAPTER_MODULE || '', voiceId: env.TWINLY_VOICE_ID || '',
    twinlyKey: env.TWINLY_API_KEY || '',
    twinlyBaseUrl: env.TWINLY_API_BASE_URL || 'https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1',
    maxAudioBytes: number('MAX_AUDIO_BYTES', 4194304, 1024, 25000000),
    maxRecordSeconds: number('MAX_RECORD_SECONDS', 60, 1, 120),
    timeoutMs: number('REQUEST_TIMEOUT_MS', 25000, 100, 120000),
    maxRetries: number('MAX_RETRIES', 1, 0, 2),
    maxRetryDelayMs: number('MAX_RETRY_DELAY_MS', 1000, 0, 3000),
    maxConcurrent: number('MAX_CONCURRENT_REQUESTS', 4, 1, 32),
    maxTtsBytes: number('MAX_TTS_BYTES', 12582912, 1024, 25000000),
    vadSilenceMs: number('VAD_SILENCE_MS', 0, 0, 3000),
    vadThreshold: number('VAD_RMS_THRESHOLD', 0.015, 0.001, 0.3),
  };
}
