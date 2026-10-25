import { StreamPlayer } from './playback.js';
import { authFetch, accessToken } from './auth.js';

const $ = id => document.getElementById(id);
const talk = $('talk'), cancel = $('cancel'), play = $('play');
const outputAudio = $('outputAudio');
let config, context, current, held = false, keyboardHeld = false, outputUrl;

function clearOutput() {
  outputAudio.pause(); outputAudio.removeAttribute('src'); outputAudio.load();
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = null; outputAudio.hidden = true;
  $('outputState').textContent = 'Waiting for audio';
  $('outputState').dataset.state = '';
  $('outputHint').hidden = false;
}
function showOutput(blob) {
  if (!blob) return;
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  outputUrl = URL.createObjectURL(blob); outputAudio.src = outputUrl;
  outputAudio.hidden = false; $('outputHint').hidden = true;
  $('outputState').textContent = 'Ready to replay';
  $('outputState').dataset.state = 'success';
}

function status(text, state = 'ready') {
  $('statusText').textContent = text; $('status').dataset.state = state;
}
function isCurrent(run) { return current === run && !run.controller.signal.aborted; }
function showError(error) {
  $('error').textContent = error.message || 'Something went wrong. Try again.';
  $('error').hidden = false; status('Error', 'error');
}
function renderTimings(run) {
  const b = run.browser, s = run.server || {};
  const rows = [
    ['Capture finalization', b.captureMs], ['End → first sound (estimate)', b.firstSoundMs],
    ...(config.vadSilenceMs ? [['VAD silence delay (estimate)', run.silenceMs],
      ['Speech end → first sound (estimate)', run.silenceMs != null && b.firstSoundMs != null ? run.silenceMs + b.firstSoundMs : null]] : []),
    ['End → final text', b.textMs], ['End → first audio bytes', b.audioMs],
    ['First bytes → first sound / decode', b.firstSoundMs != null && b.audioMs != null ? b.firstSoundMs - b.audioMs : null],
    ['Upload receive (server)', s.receiveMs], [config.mode === 'mock' ? 'STT (mock)' : 'Groq STT', s.sttMs], ['Rule cleanup', s.rulesMs],
    [config.mode === 'mock' ? 'First token (mock)' : 'Google first token', s.llmFirstTokenMs],
    [config.mode === 'mock' ? 'Cleanup (mock)' : 'Google completion', s.llmMs],
    ['TTS first byte', s.ttsFirstByteMs], ['TTS stream + client backpressure', s.ttsStreamMs],
    ['Server total', s.serverTotalMs], ['End → finished / canceled', b.finishedMs],
  ];
  $('timings').replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value == null ? '—' : `${Math.max(0, value).toFixed(value < 10 ? 1 : 0)} ms`;
    $('timings').append(dt, dd);
  }
  $('timingSummary').textContent = b.firstSoundMs != null ? `Latency · ${(b.firstSoundMs / 1000).toFixed(2)}s to first sound (est.)`
    : b.textMs != null ? `Latency · ${(b.textMs / 1000).toFixed(2)}s to text` : 'Latency · measurements in progress';
}
function releaseCapture(run) {
  clearTimeout(run.maxTimer); cancelAnimationFrame(run.vadFrame);
  run.micSource?.disconnect(); run.analyser?.disconnect();
  run.stream?.getTracks().forEach(track => track.stop());
}
function cancelRun(message = 'Canceled') {
  outputAudio.pause();
  if (outputUrl) outputAudio.currentTime = 0;
  held = false; keyboardHeld = false; talk.dataset.held = 'false'; $('talkLabel').textContent = 'Hold to Talk';
  if (current) {
    const run = current;
    run.controller.abort(new DOMException('Canceled', 'AbortError'));
    if (run.recorder?.state === 'recording') run.recorder.stop();
    releaseCapture(run);
    if (run.endAt) { run.browser.finishedMs = performance.now() - run.endAt; renderTimings(run); }
    current = null;
  }
  play.hidden = true; play.onclick = null; cancel.disabled = true;
  status(message);
}

function playbackGate(run) {
  return new Promise((resolve, reject) => {
    if (!isCurrent(run)) { reject(run.controller.signal.reason); return; }
    status('Tap Enable playback to continue', 'processing');
    play.hidden = false;
    const abort = () => { play.hidden = true; play.onclick = null; reject(run.controller.signal.reason); };
    run.controller.signal.addEventListener('abort', abort, { once: true });
    play.onclick = async () => {
      try {
        await context.resume();
        if (context.state !== 'running') throw new Error('Browser audio is blocked. Allow playback and try again.');
        run.controller.signal.removeEventListener('abort', abort);
        play.hidden = true; play.onclick = null; resolve();
      } catch (error) { reject(error); }
    };
  });
}

function watchVoice(run) {
  // A tiny energy detector, not a language-aware VAD. Off by default because
  // long pauses and quiet speech must not silently truncate intended wording.
  if (!config.vadSilenceMs) return;
  run.micSource = context.createMediaStreamSource(run.stream);
  run.analyser = context.createAnalyser(); run.analyser.fftSize = 1024;
  run.micSource.connect(run.analyser);
  const samples = new Float32Array(1024);
  let voiceMs = 0, previous = performance.now(), lastVoice = previous;
  const check = () => {
    if (!isCurrent(run) || run.recorder.state !== 'recording') return;
    const now = performance.now(); run.analyser.getFloatTimeDomainData(samples);
    const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    if (rms > config.vadThreshold) { voiceMs += Math.min(50, now - previous); lastVoice = now; }
    previous = now;
    if (voiceMs >= 150 && now - lastVoice >= config.vadSilenceMs) {
      run.silenceMs = now - lastVoice; endRecording(run); return;
    }
    run.vadFrame = requestAnimationFrame(check);
  };
  run.vadFrame = requestAnimationFrame(check);
}

async function beginRecording() {
  if (held || !config) return;
  if (current) cancelRun();
  held = true;
  const run = { controller: new AbortController(), browser: {}, server: {}, chunks: [] };
  current = run; cancel.disabled = false;
  clearOutput();
  $('error').hidden = true; $('transcript').value = ''; $('textState').textContent = 'Awaiting transcript';
  $('textState').dataset.state = '';
  $('transcriptHint').textContent = 'Your cleaned words appear here after you release.';
  $('timingSummary').textContent = 'Latency · waiting for speech end'; $('timings').replaceChildren();
  status('Opening microphone…', 'listening');
  talk.dataset.held = 'true'; $('talkLabel').textContent = 'Release to finish';
  try {
    // Must run synchronously inside the pointer/key gesture, before mic permission.
    context ||= new AudioContext({ latencyHint: 'interactive' });
    context.resume().catch(() => {});
    run.player = new StreamPlayer(context, run.controller.signal, estimated => {
      if (!isCurrent(run)) return;
      run.browser.firstSoundMs = estimated - run.endAt;
      status('Speaking', 'speaking'); renderTimings(run);
    }, () => playbackGate(run));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } });
    run.stream = stream;
    if (!isCurrent(run) || !held) {
      releaseCapture(run);
      if (isCurrent(run)) cancelRun('Ready · hold again to record');
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser has no supported recording format. Try current Chrome, Firefox, or Safari.');
    const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    run.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size && isCurrent(run)) run.chunks.push(event.data); };
    recorder.onerror = () => {
      if (!isCurrent(run)) return;
      cancelRun(); showError(new Error('Microphone recording failed. Try again.'));
    };
    recorder.onstop = () => {
      if (!run.endAt) {
        run.endAt = performance.now();
        held = false; talk.dataset.held = 'false'; $('talkLabel').textContent = 'Hold to Talk';
      }
      releaseCapture(run);
      if (isCurrent(run)) processRecording(run, mimeType);
    };
    recorder.start(); // One complete compressed file. Groq STT is not streaming.
    run.startedAt = performance.now();
    run.maxTimer = setTimeout(() => endRecording(run), config.maxRecordSeconds * 1000);
    status('Listening', 'listening'); watchVoice(run);
  } catch (error) {
    if (!isCurrent(run)) return;
    cancelRun();
    showError(new Error(error.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser and try again.' : error.message));
  }
}

function endRecording(run = current) {
  held = false; talk.dataset.held = 'false'; $('talkLabel').textContent = 'Hold to Talk';
  if (!run || !isCurrent(run)) return;
  if (run.recorder?.state === 'recording') {
    run.endAt = performance.now();
    status('Processing · finalizing capture', 'processing');
    run.recorder.stop();
    clearTimeout(run.maxTimer); cancelAnimationFrame(run.vadFrame);
  }
}

async function consumeEvents(response, run) {
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let pending = '', completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      run.controller.signal.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 524288) throw new Error('Server response is too large.');
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.timings) run.server = { ...event.timings };
        if (event.type === 'status') status(`Processing · ${event.stage}`, 'processing');
        if (event.type === 'preview') { $('transcript').value = event.text; $('textState').textContent = 'Cleaning…'; }
        if (event.type === 'cleaned') {
          $('transcript').value = event.text; $('textState').textContent = 'Final';
          $('textState').dataset.state = event.text ? 'success' : '';
          $('transcriptHint').textContent = event.text ? 'Final text · used for voice output.' : 'No speech detected. Hold to talk and try again.';
          run.browser.textMs = performance.now() - run.endAt;
          status(event.text ? 'Processing · preparing audio' : 'No speech detected', 'processing');
        }
        if (event.type === 'format') run.player.setFormat(event.format);
        if (event.type === 'audio') {
          run.browser.audioMs ??= performance.now() - run.endAt;
          await run.player.push(event.data);
        }
        if (event.type === 'error') throw new Error(event.error);
        if (event.type === 'done') completed = true;
        renderTimings(run);
      }
      if (done) break;
    }
    if (!completed || pending.trim()) throw new Error('The response was interrupted. Try again.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function processRecording(run, mimeType) {
  const blob = new Blob(run.chunks, { type: mimeType }); run.chunks = [];
  run.browser.captureMs = performance.now() - run.endAt;
  if (performance.now() - run.startedAt < 150 || !blob.size) { cancelRun('Too short · hold to speak'); return; }
  if (blob.size > config.maxAudioBytes) { cancelRun(); showError(new Error('Recording is too large. Try a shorter utterance.')); return; }
  // Deadline also covers a stalled connection or browser-side playback gate.
  const timeout = setTimeout(() => {
    if (isCurrent(run)) { cancelRun(); showError(new Error('Request timed out. Try a shorter utterance.')); }
  }, config.timeoutMs + 10000);
  try {
    const response = await authFetch('/api/process', { method: 'POST', headers: { 'Content-Type': mimeType },
      body: blob, signal: run.controller.signal });
    if (!response.ok) {
      if (config.auth && response.status === 401) { location.assign(`/call?next=${location.pathname}`); return; }
      const error = await response.json();
      if (error.timings) { run.server = error.timings; renderTimings(run); }
      throw new Error(error.error || `Server returned HTTP ${response.status}.`);
    }
    await consumeEvents(response, run);
    clearTimeout(timeout); // Network work is finished; remaining audio may be long.
    showOutput(run.player.audioBlob());
    await run.player.finish();
    if (isCurrent(run)) {
      run.browser.finishedMs = performance.now() - run.endAt; renderTimings(run);
      console.info('Sugarcoat timing (ms)', { browser: run.browser, server: run.server, vadSilenceMs: run.silenceMs || 0 });
      current = null; cancel.disabled = true; status($('transcript').value ? 'Ready' : 'No speech detected');
    }
  } catch (error) {
    if (isCurrent(run)) { cancelRun(); showError(error); }
  } finally { clearTimeout(timeout); }
}

talk.addEventListener('pointerdown', event => {
  if (event.button !== 0 || held) return;
  event.preventDefault(); talk.focus(); talk.setPointerCapture(event.pointerId); beginRecording();
});
talk.addEventListener('pointerup', () => endRecording());
talk.addEventListener('pointercancel', () => { if (held) cancelRun(); });
talk.addEventListener('lostpointercapture', () => { if (held) endRecording(); });
talk.addEventListener('contextmenu', event => event.preventDefault());
talk.addEventListener('keydown', event => {
  if (event.code === 'Space') {
    event.preventDefault();
    if (!event.repeat) { beginRecording(); keyboardHeld = true; }
  }
});
talk.addEventListener('keyup', event => {
  if (event.code === 'Space') { event.preventDefault(); keyboardHeld = false; endRecording(); }
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') cancelRun(); });
window.addEventListener('blur', () => { if (held || keyboardHeld) cancelRun(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (current || !outputAudio.paused)) cancelRun(); });
cancel.addEventListener('click', () => cancelRun());
outputAudio.addEventListener('play', () => {
  // Native replay and the initial WebAudio playback must never overlap.
  if (current) {
    const run = current;
    run.controller.abort(new DOMException('Replaying completed output', 'AbortError'));
    releaseCapture(run); current = null;
  }
  status('Speaking', 'speaking'); cancel.disabled = false;
});
outputAudio.addEventListener('pause', () => {
  if (!current && outputAudio.paused && $('status').dataset.state !== 'error') { status('Ready'); cancel.disabled = true; }
});
outputAudio.addEventListener('ended', () => {
  if (!current) { status('Ready'); cancel.disabled = true; }
});
outputAudio.addEventListener('error', () => {
  if (outputUrl) { cancelRun(); showError(new Error('This browser could not play the generated audio format.')); }
});
window.addEventListener('pagehide', () => { cancelRun(); clearOutput(); });

try {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error('Could not connect to the server. Reload to try again.');
  config = await response.json();
  // With accounts enabled, sign in on the Comms page first; it sends you back here.
  if (config.auth && !await accessToken()) { location.replace(`/call?next=${location.pathname}`); await new Promise(() => {}); }
  $('mode').textContent = config.mode === 'mock' ? 'MOCK MODE · example transcript + test tone. Your recording is not transcribed.'
    : config.tts === 'mock' ? 'LIVE TRANSCRIPTION + CLEANUP · test-tone output. No cloned speech.' : 'LIVE MODE · Groq → Google → Twinly';
  $('mode').dataset.state = config.mode === 'mock' || config.tts === 'mock' ? 'warning' : '';
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
    throw new Error('Recording needs HTTPS or localhost and a modern browser.');
  }
  talk.disabled = false;
  status('Ready');
} catch (error) { showError(error); }
