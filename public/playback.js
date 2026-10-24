export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Reuses an AudioContext unlocked by the Hold gesture. PCM starts without waiting
// for the complete utterance; encoded formats use decodeAudioData after EOF.
export class StreamPlayer {
  constructor(context, signal, onFirstSound, onBlocked) {
    Object.assign(this, { context, signal, onFirstSound, onBlocked });
    this.nodes = new Set(); this.timers = new Set(); this.parts = [];
    this.nextTime = 0; this.remainder = null; this.started = false;
    this.finished = false; this.bytes = 0;
    signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  setFormat(format) {
    if (this.format) throw new Error('Audio format changed during playback.');
    if (format?.encoding === 'pcm_s16le' && format.channels === 1 &&
        Number.isInteger(format.sampleRate) && format.sampleRate >= 8000 && format.sampleRate <= 48000) {
      this.format = format;
    } else if (format?.encoding === 'encoded' && typeof format.mimeType === 'string') {
      this.format = format;
    } else throw new Error('Unsupported playback format.');
  }

  async push(base64) {
    this.signal.throwIfAborted();
    if (!this.format) throw new Error('Audio arrived without a format.');
    const binary = atob(base64);
    let bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    this.bytes += bytes.length;
    if (this.bytes > 25000000) throw new Error('Playback audio is too large.');
    this.parts.push(bytes);
    if (this.format.encoding === 'encoded') return;
    if (this.remainder !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.remainder; joined.set(bytes, 1); bytes = joined;
      this.remainder = null;
    }
    if (bytes.length % 2) { this.remainder = bytes[bytes.length - 1]; bytes = bytes.subarray(0, -1); }
    if (!bytes.length) return;
    const buffer = this.context.createBuffer(1, bytes.length / 2, this.format.sampleRate);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    await this.schedule(buffer);
  }

  async schedule(buffer) {
    if (this.context.state !== 'running') await this.onBlocked();
    this.signal.throwIfAborted();
    // Bound scheduled audio, memory and cancellation work; backpressure reaches
    // fetch and then the server instead of scheduling an entire long speech.
    while (this.nextTime - this.context.currentTime > 0.35) await wait(25, this.signal);
    this.signal.throwIfAborted();
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination);
    this.nodes.add(source);
    source.onended = () => {
      source.disconnect(); this.nodes.delete(source);
      if (this.finished && this.nodes.size === 0 && this.timers.size === 0) this.resolveFinished?.();
    };
    const at = Math.max(this.context.currentTime + 0.025, this.nextTime);
    source.start(at);
    this.nextTime = at + buffer.duration;
    if (!this.started) {
      this.started = true;
      const stamp = this.context.getOutputTimestamp?.();
      const estimated = stamp?.performanceTime > 0
        ? stamp.performanceTime + (at - stamp.contextTime) * 1000
        : performance.now() + (at - this.context.currentTime + (this.context.baseLatency || 0) + (this.context.outputLatency || 0)) * 1000;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (!this.signal.aborted) this.onFirstSound(estimated);
        if (this.finished && this.nodes.size === 0 && this.timers.size === 0) this.resolveFinished?.();
      }, Math.max(0, estimated - performance.now()));
      this.timers.add(timer);
    }
  }

  async finish() {
    this.signal.throwIfAborted();
    if (this.format?.encoding === 'encoded') {
      const all = new Uint8Array(this.bytes);
      let offset = 0;
      for (const part of this.parts) { all.set(part, offset); offset += part.length; }
      const buffer = await this.context.decodeAudioData(all.buffer);
      this.signal.throwIfAborted();
      await this.schedule(buffer);
    }
    if (this.remainder !== null) throw new Error('TTS returned incomplete PCM audio.');
    this.finished = true;
    if (this.nodes.size || this.timers.size) await new Promise((resolve, reject) => {
      const abort = () => reject(this.signal.reason);
      this.resolveFinished = () => { this.signal.removeEventListener('abort', abort); resolve(); };
      this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
  }

  audioBlob() {
    if (!this.bytes || !this.format) return null;
    if (this.format.encoding === 'encoded') return new Blob(this.parts, { type: this.format.mimeType });
    if (this.bytes % 2) throw new Error('TTS returned incomplete PCM audio.');
    const header = new ArrayBuffer(44), view = new DataView(header);
    const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, 36 + this.bytes, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, this.format.sampleRate, true);
    view.setUint32(28, this.format.sampleRate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, this.bytes, true);
    return new Blob([header, ...this.parts], { type: 'audio/wav' });
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const source of this.nodes) { source.onended = null; source.stop(); source.disconnect(); }
    this.nodes.clear(); this.parts = []; this.remainder = null;
  }
}
