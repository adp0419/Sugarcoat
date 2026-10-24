import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { AppError, retryDelay } from '../http.mjs';

const TERMINAL = new Set(['done', 'failed', 'canceled', 'expired']);
const ACTIVE = new Set(['queued', 'running', 'needs_approval']);
const AUDIO_MIMES = new Set(['audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm']);
const MESSAGES = {
  twinly_offline: 'Open Twinly on the key owner’s Mac, sign in, and enable Jobs on this Mac. Keep the Mac awake.',
  voice_not_set_up: 'Build your voice clone on Twinly’s Voice screen first.',
  voice_starting: 'Twinly’s voice engine is starting. Try again in a minute.',
  voice_failed: 'Twinly could not synthesize the audio. Try a shorter recording.',
  scope_missing: 'This Twinly key needs the voice scope enabled.',
  invalid_api_key: 'Twinly rejected the API key. Check TWINLY_API_KEY.',
  insufficient_usage: 'Twinly has insufficient usage. Check your plan or extra usage.',
  free_prompts_used: 'Twinly’s free prompts are exhausted. Check your plan or extra usage.',
  plan_limit_reached: 'Twinly’s plan limit was reached. Wait for the reset or add usage.',
  key_cap_reached: 'This Twinly key reached its spending cap.',
  job_unverified: 'Twinly may have created the voice job but could not confirm it. Check Twinly’s task list before trying again.',
  billing_record_failed: 'Twinly could not confirm billing. Check its task list before trying again.',
  billing_unverified: 'Twinly could not confirm billing. Check its task list before trying again.',
  declined: 'Voice generation was declined in Twinly. No replacement voice was used.',
  not_allowed: 'Twinly’s approval policy refused voice generation. Check its policy settings.',
  stopped_by_owner: 'Voice generation was stopped in Twinly.',
  canceled: 'Twinly voice generation was canceled.',
  queue_timeout: 'Twinly’s voice queue timed out. Try again when the Mac is free.',
};

// Documented job API, not a streaming TTS endpoint. The key selects its owner's
// existing clone; this API has no voice-id field and never sends a message/call.
export function createTwinlyAdapter(config, fetchImpl = fetch) {
  const base = new URL(config.twinlyBaseUrl);
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('TWINLY_API_BASE_URL must be HTTPS, or HTTP on localhost for tests.');
  }
  const baseUrl = base.href.replace(/\/$/u, '');
  const headers = { Authorization: `Bearer ${config.twinlyKey}`, 'Content-Type': 'application/json' };

  async function request(path, { method = 'GET', body, signal, retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(baseUrl + path, { method, headers, signal,
          ...(body ? { body: JSON.stringify(body) } : {}) });
      } catch {
        signal.throwIfAborted();
        throw new AppError(method === 'POST'
          ? 'Twinly connection failed. A voice job may exist; check Twinly before trying again.'
          : 'Could not reach Twinly. Check your connection.', 502, 'TWINLY_NETWORK_ERROR');
      }
      // A successful result may contain up to 8 MiB of base64-encoded audio.
      const limit = Math.ceil(Math.min(config.maxTtsBytes, 8 * 1024 * 1024) / 3) * 4 + 65536;
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      try {
        if (!reader) throw new AppError('Twinly returned an empty response.');
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new AppError('Twinly audio response exceeded the size limit.', 502, 'TWINLY_AUDIO_LIMIT');
          chunks.push(value);
        }
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
      let json;
      try { json = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { throw new AppError('Twinly returned invalid JSON.', 502, 'TWINLY_INVALID_RESPONSE'); }
      if (response.ok) return json;
      const code = json.error?.code || 'TWINLY_ERROR';
      const wait = retryDelay(response.headers.get('retry-after'));
      const backoff = wait ?? (200 * 2 ** attempt + Math.floor(Math.random() * 100));
      // Job creation must never repeat ambiguous submissions or billing failures.
      const unsafe = ['job_unverified', 'billing_unverified', 'billing_record_failed'].includes(code);
      const canRetry = !unsafe && (method === 'GET' ? [429, 503].includes(response.status)
        : (response.status === 429 && code === 'rate_limited') || response.status === 503);
      if (retry && canRetry && attempt < config.maxRetries && backoff <= config.maxRetryDelayMs) {
        await delay(backoff, undefined, { signal }); continue;
      }
      const message = MESSAGES[code] || (response.status === 429
        ? `Twinly is rate limited.${wait !== null ? ` Retry after ${Math.max(1, Math.ceil(wait / 1000))} seconds.` : ' Try again shortly.'}`
        : `Twinly returned HTTP ${response.status} (${String(code).replace(/[^a-zA-Z0-9_]/gu, '').slice(0, 64)}).`);
      throw new AppError(message, response.status === 429 ? 429 : 502, code, wait === null ? undefined : Math.ceil(wait / 1000));
    }
  }

  return async function synthesize({ text, signal, onStatus = async () => {} }) {
    if (!config.twinlyKey) throw new AppError('Set TWINLY_API_KEY on the server.', 503, 'TWINLY_NOT_CONFIGURED');
    if (text.length > 600) throw new AppError('Twinly accepts up to 600 characters per voice line. Record a shorter utterance; your full cleaned text is shown above.', 422, 'TWINLY_TEXT_LIMIT');
    let id, terminal = false, cancelPromise;
    const cancelJob = () => {
      if (!id || terminal) return Promise.resolve();
      // A running voice job cannot be stopped by Twinly; it may finish and be
      // charged. Client cancellation always suppresses playback of its result.
      return cancelPromise ||= request(`/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST', signal: AbortSignal.timeout(3000), retry: false,
      }).catch(() => {});
    };
    const aborted = () => { void cancelJob(); };
    signal.addEventListener('abort', aborted, { once: true });
    try {
      // Obtain the ID promptly so queued work can be canceled. Waiting in the
      // creating POST would hide the ID until synthesis finishes or times out.
      let job = await request('/voice/speak?wait=0', { method: 'POST', body: { text }, signal });
      if (typeof job.id !== 'string' || !job.id || job.id.length > 128) throw new AppError('Twinly returned no valid job ID.');
      id = job.id;
      while (true) {
        signal.throwIfAborted();
        if (TERMINAL.has(job.status)) { terminal = true; break; }
        if (!ACTIVE.has(job.status)) throw new AppError('Twinly returned an unknown voice job status.');
        await onStatus(job.status === 'needs_approval' ? 'Twinly needs approval in its Mac app' : `Twinly voice ${job.status}`);
        const previousStatus = job.status;
        const started = performance.now();
        job = await request(`/jobs/${encodeURIComponent(id)}?wait=25`, { signal });
        // Bound polling even if a proxy immediately returns unchanged status.
        if (job.status === previousStatus && !TERMINAL.has(job.status) && performance.now() - started < 200) {
          await delay(200 - (performance.now() - started), undefined, { signal });
        }
      }
      if (job.status !== 'done') throw new AppError(MESSAGES[job.error?.code] || `Twinly voice job ${job.status}. Check Twinly’s task list.`, 502, job.error?.code || 'TWINLY_JOB_FAILED');
      const result = job.result;
      const b64 = result?.audio_b64;
      if (!AUDIO_MIMES.has(result?.mime) || typeof b64 !== 'string' || !b64.length ||
          b64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(b64)) {
        throw new AppError('Twinly returned invalid audio or an unsupported format.', 502, 'TWINLY_INVALID_AUDIO');
      }
      const audio = Buffer.from(b64, 'base64');
      if (audio.length > config.maxTtsBytes || audio.length > 8 * 1024 * 1024) throw new AppError('Twinly audio exceeded the size limit.');
      return {
        format: { encoding: 'encoded', mimeType: result.mime },
        stream: (async function* () {
          for (let offset = 0; offset < audio.length; offset += 12288) {
            signal.throwIfAborted(); yield audio.subarray(offset, offset + 12288);
          }
        })(),
      };
    } finally {
      signal.removeEventListener('abort', aborted);
      if (!terminal) await cancelJob();
    }
  };
}
