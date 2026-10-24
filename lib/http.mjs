import { setTimeout as delay } from 'node:timers/promises';

export class AppError extends Error {
  constructor(message, status = 502, code = 'PROVIDER_ERROR', retryAfter) {
    super(message);
    Object.assign(this, { status, code, retryAfter });
  }
}

export function retryDelay(value, now = Date.now()) {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export async function providerFetch(label, url, makeInit, config, signal, fetchImpl = fetch) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, { ...makeInit(), signal });
    } catch (error) {
      signal.throwIfAborted();
      // Do not retry ambiguous network failures: provider may already have billed.
      throw new AppError(`${label} could not be reached. Try again.`, 502, 'NETWORK_ERROR');
    }
    if (response.ok) return response;
    const wait = retryDelay(response.headers.get('retry-after'));
    await response.body?.cancel();
    const transient = [429, 500, 502, 503, 504].includes(response.status);
    const backoff = wait ?? (200 * 2 ** attempt + Math.floor(Math.random() * 100));
    if (transient && attempt < config.maxRetries && backoff <= config.maxRetryDelayMs) {
      await delay(backoff, undefined, { signal });
      continue;
    }
    const status = response.status;
    const message = status === 429 ? `${label} rate limit reached. ${wait !== null ? `Retry after ${Math.max(1, Math.ceil(wait / 1000))} seconds.` : 'Try again shortly.'}`
      : [401, 403].includes(status) ? `${label} rejected the API key or model access.`
      : status === 404 ? `${label} model or endpoint is unavailable. Check server configuration.`
      : `${label} returned HTTP ${status}. Try again.`;
    throw new AppError(message, status === 429 ? 429 : 502, 'PROVIDER_ERROR', wait === null ? undefined : Math.ceil(wait / 1000));
  }
}

// Incremental parser: SSE frames can span any number of network chunks.
export async function* sseData(body, signal) {
  if (!body) throw new AppError('Google returned no response stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '', data = [];
  const line = (value) => {
    if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 262144) throw new AppError('Google response frame is too large.');
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, index).replace(/\r$/u, '');
        pending = pending.slice(index + 1);
        if (value === '') {
          if (data.length) yield data.join('\n');
          data = [];
        } else line(value);
      }
      if (done) break;
    }
    if (pending) line(pending.replace(/\r$/u, ''));
    if (data.length) yield data.join('\n');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
