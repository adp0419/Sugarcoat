// Call page: push-to-talk in, queued clips out. Talks to /api/call/* only.
// Playback is a small copy of the decode-and-schedule idea in playback.js (which
// stays untouched); the only difference is that each clip is fetched by URL.
const $ = id => document.getElementById(id);
const talk = $('talk'), cancel = $('cancel'), joinBtn = $('join'), leaveBtn = $('leave'), enableBtn = $('enable');
const NAMES = { aryan: 'Aryan', rohit: 'Rohit' };
const MIN_HOLD_MS = 300, MAX_RECORD_MS = 60000;
const INVALID_LINK = 'This link isn’t valid. Ask for a new one.';

const params = new URLSearchParams(location.search);
const token = params.get('t') || ''; // kept in memory only; never rendered
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lsGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
const lsSet = (key, value) => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} };
const pick = value => (value = String(value || '').toLowerCase()) in NAMES ? value : '';

let me = pick(params.get('as')) || pick(lsGet('vf-call-as'));
let joined = false, connected = false, everOpened = false, errorsInRow = 0;
let connectId = 0, pollAbort;
let ctx, micStream, micPromise, micId = lsGet('vf-call-mic') || '', speakerId = lsGet('vf-call-speaker') || '';
let rec = null, sending = false, pumping = false, currentSource, currentAudio, gateRelease;
const turns = new Map();   // utterance id -> { id, who, entry, ... }
const queue = [];          // peer utterances in arrival order
const sentPending = [];    // my utterances waiting for "delivered"
let sentCounter = 0;

const peerOf = who => (who === 'aryan' ? 'rohit' : 'aryan');
const peerName = () => NAMES[peerOf(me)] || 'the other person';

/* ---------- Status and errors ---------- */
function setStatus(text, state = 'ready') { $('statusText').textContent = text; $('status').dataset.state = state; }
function showError(text) { $('error').textContent = text; $('error').hidden = false; }
function hideError() { $('error').hidden = true; $('error').textContent = ''; }
function setLinkError(text) { $('linkError').textContent = text || ''; $('linkError').hidden = !text; }
function setConnection(text, state) { $('connection').textContent = text; $('connection').dataset.state = state; }
function setPresence(online) {
  const el = $('presence');
  if (online == null) { el.dataset.state = 'idle'; $('presenceText').textContent = 'Join the call to see who is here.'; return; }
  el.dataset.state = online ? 'online' : 'offline';
  $('presenceText').textContent = online ? `${peerName()} is online.` : `${peerName()} is offline. They’ll hear you once they join.`;
}

function micError(error) {
  const name = error?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Your microphone is blocked. Allow it from the lock icon in the address bar, then hold the button again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found. Plug one in or choose another under “Microphone and speaker”, then try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'Another app is using your microphone. Close it, then try again.';
  return error?.message || 'The microphone failed. Try again.';
}
// Map what the relay or Twinly reports onto a plain sentence plus the next step.
function describeFailure(message = '', code = '', httpStatus = 0) {
  const id = String(code).toLowerCase(), text = `${id} ${message}`.toLowerCase();
  const sentence = String(message).trim().replace(/[.!]?$/, '.');
  if (httpStatus === 401 || id === 'bad_token') return INVALID_LINK;
  if (id === 'bad_origin') return 'This page was opened from a different address than the call server expects. Open the exact link you were given, or ask the host.';
  if (id === 'peer_offline') return `${peerName()} isn’t on the call. Ask them to open their link and press Join call, then try again.`;
  if (id === 'call_line_cap' || id === 'twinly_not_configured' || id === 'missing_keys' || id === 'call_not_configured') return `${sentence} Ask the host to fix it.`;
  if (httpStatus === 413 || /audio_limit|too (large|long|big)/.test(text)) return 'That was too long to send. Hold the button for a shorter message.';
  if (id === 'empty_audio') return 'No sound was recorded. Check your microphone and try again.';
  if (id === 'timeout') return 'That took too long. Try a shorter message.';
  if (/needs_approval|approval|declined|not_allowed|stopped_by_owner/.test(text)) return 'Twinly needs approval before it can speak in your voice. Open Twinly on the host Mac, approve the voice request, then try again.';
  if (/rate_limited|rate limit|plan_limit|key_cap|insufficient_usage|free_prompts/.test(text) || httpStatus === 429) return 'Twinly is rate limited or out of usage. Wait a minute, or ask the host to check the plan, then try again.';
  if (/twinly_offline|voice_starting|queue_timeout|econnrefused|twinly.*(offline|unreachable)/.test(text)) return 'Twinly is offline, so your voice can’t be generated. Open Twinly on the host Mac, keep it awake, then try again.';
  if (message) return `${sentence} Try again.`;
  return httpStatus >= 500 ? 'The call server had a problem. Try again in a moment.' : 'Something went wrong. Try again.';
}

/* ---------- Layout state ---------- */
const incomingBusy = () => queue.some(turn => !turn.done);
function refresh() {
  const playing = incomingBusy();
  const idle = !rec && !sending;
  let label = 'Hold to Talk', reason = '', keys = true, disabled = false;
  if (!joined) { disabled = true; reason = 'Join the call first.'; keys = false; label = 'Join to talk'; }
  else if (!connected) { disabled = true; reason = 'Reconnecting. You can talk again once the call is back.'; keys = false; }
  else if (rec) { label = 'Release to send'; reason = 'Release to send, or press Esc to cancel.'; keys = false; }
  else if (sending) { disabled = true; label = 'Cleaning…'; reason = 'Cleaning your words. Wait for it to be sent.'; keys = false; }
  else if (playing) { disabled = true; label = `${peerName()} is speaking`; reason = `Waiting for ${peerName()} to finish. One voice at a time.`; keys = false; }
  talk.disabled = disabled;
  $('talkLabel').textContent = label;
  talk.dataset.held = rec ? 'true' : 'false';
  talk.setAttribute('aria-label', rec ? 'Recording. Release to send.' : disabled ? `${label}. ${reason}` : 'Hold to talk. Release to send.');
  $('hintText').textContent = reason;
  $('hintKeys').hidden = !keys;
  $('hintText').hidden = !reason;
  cancel.disabled = !rec;
  joinBtn.hidden = joined; leaveBtn.hidden = !joined;
  document.querySelectorAll('input[name="who"]').forEach(input => { input.disabled = joined; input.checked = input.value === me; });
  $('micSelect').disabled = !joined; $('speakerSelect').disabled = !joined || !ctx?.setSinkId;
  if (joined && idle) {
    if (!connected) setStatus('Reconnecting', 'processing');
    else if (playing) setStatus(`${peerName()} is speaking`, 'speaking');
    else if (['Reconnecting', `${peerName()} is speaking`, 'Join the call to talk'].includes($('statusText').textContent)) setStatus('Ready');
  }
}

/* ---------- Conversation ---------- */
const log = $('log');
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
function countEntries() {
  const count = log.children.length;
  $('logState').textContent = count ? `${count} message${count === 1 ? '' : 's'}` : 'No messages yet';
}
// One chat bubble: name and time, the words, then a status chip.
function addEntry(who, text, mark, markState) {
  const follow = nearBottom();
  const li = document.createElement('li'); li.className = 'turn'; li.dataset.who = who;
  const meta = document.createElement('p'); meta.className = 'meta';
  const label = document.createElement('span'); label.className = 'who'; label.textContent = who === 'you' ? 'You' : peerName();
  const time = document.createElement('time'); const at = new Date();
  time.dateTime = at.toISOString(); time.textContent = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  meta.append(label, time);
  const said = document.createElement('p'); said.className = 'said'; said.textContent = text;
  const markEl = document.createElement('span'); markEl.className = 'flag';
  li.append(meta, said, markEl); log.append(li);
  const entry = { li, said, markEl };
  setMark(entry, mark, markState);
  countEntries();
  if (follow) log.scrollTop = log.scrollHeight;
  return entry;
}
function setText(entry, text, pending = false) {
  if (!entry) return;
  const follow = nearBottom();
  entry.said.textContent = text; entry.said.dataset.pending = pending ? 'true' : 'false';
  if (follow) log.scrollTop = log.scrollHeight;
}
function removeEntry(entry) { entry?.li.remove(); countEntries(); }
function setMark(entry, text, state = '') {
  if (!entry) return;
  entry.markEl.textContent = text; entry.markEl.dataset.state = state;
}

/* ---------- Audio context, devices ---------- */
function applySink() {
  if (ctx?.setSinkId) ctx.setSinkId(speakerId || '').catch(() => { speakerId = ''; lsSet('vf-call-speaker', ''); });
}
async function ensureRunning() {
  if (ctx.state === 'running') return;
  await ctx.resume().catch(() => {});
  if (ctx.state === 'running') return;
  enableBtn.hidden = false;
  setStatus(`Press Enable playback to hear ${peerName()}`, 'processing');
  await new Promise(resolve => {
    gateRelease = resolve;
    enableBtn.onclick = async () => { await ctx.resume().catch(() => {}); if (ctx.state === 'running') resolve(); };
  });
  gateRelease = null; enableBtn.hidden = true; enableBtn.onclick = null;
}

function ensureMic() {
  if (micStream?.getAudioTracks().some(track => track.readyState === 'live')) return Promise.resolve(micStream);
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error('Calling needs HTTPS or localhost and a current browser.'), { name: 'NotSupported' }));
  micPromise ||= (async () => {
    const base = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: micId ? { ...base, deviceId: { exact: micId } } : base }); }
    catch (error) {
      if (!micId || error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error;
      micId = ''; lsSet('vf-call-mic', ''); // saved device is gone: fall back to the default
      stream = await navigator.mediaDevices.getUserMedia({ audio: base });
    }
    micStream = stream;
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (micStream === stream) micStream = null; }));
    listDevices();
    return stream;
  })().finally(() => { micPromise = null; });
  return micPromise;
}
function releaseMic() { micStream?.getTracks().forEach(track => track.stop()); micStream = null; }

async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  let devices;
  try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const fill = (select, kind, saved, fallback) => {
    const list = devices.filter(device => device.kind === kind && device.deviceId);
    select.replaceChildren(new Option(fallback, ''));
    list.forEach((device, index) => select.append(new Option(device.label || `${fallback.split(' ')[1]} ${index + 1}`, device.deviceId)));
    select.value = list.some(device => device.deviceId === saved) ? saved : '';
    return list.some(device => device.label);
  };
  const named = fill($('micSelect'), 'audioinput', micId, 'Default microphone');
  fill($('speakerSelect'), 'audiooutput', speakerId, 'Default speaker');
  $('listDevices').hidden = named;
  $('deviceNote').textContent = ctx && !ctx.setSinkId ? 'This browser plays through your system output. Change the speaker in system sound settings.' : '';
}

/* ---------- Connection ---------- */
const withToken = path => `${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(me)}&t=${encodeURIComponent(token)}`;

function invalidLink() {
  stopConnection();
  joined = false; connected = false;
  setConnection('Link not valid', 'error'); setPresence(null);
  setLinkError(INVALID_LINK);
  teardownCall(); refresh(); setStatus('Join the call to talk');
}
function stopConnection() { connectId++; pollAbort?.abort(); pollAbort = null; }
// Long-poll /api/call/poll instead of SSE: tunnels such as cloudflared quick
// tunnels buffer an event stream until it closes, so nothing would arrive.
const handlers = { caption: onCaption, clip: onClip, delivered: onDelivered, error: onRelayError };
async function openStream() {
  const id = ++connectId;
  let cursor = null;
  while (joined && id === connectId) {
    const abort = pollAbort = new AbortController(), timer = setTimeout(() => abort.abort(), 40000);
    let body = null, status = 0;
    try {
      const response = await fetch(withToken(cursor == null ? '/api/call/poll' : `/api/call/poll?after=${cursor}`), { cache: 'no-store', signal: abort.signal });
      status = response.status;
      if (response.ok) body = await response.json();
    } catch {} finally { clearTimeout(timer); }
    if (!joined || id !== connectId) return;
    if (status === 401) { invalidLink(); return; }
    if (!body) {
      connected = false; errorsInRow++;
      setConnection(everOpened ? 'Reconnecting…' : 'Connecting…', 'wait'); refresh();
      if (status === 403) setLinkError(describeFailure('', 'BAD_ORIGIN', 403));
      else if (status >= 400) setLinkError('The call server rejected the connection. Reload the page, or ask for a new link.');
      else if (errorsInRow >= 3) setLinkError('Can’t reach the call server. Check your connection. This page keeps trying.');
      await sleep(Math.min(8000, 1000 * 2 ** Math.min(errorsInRow - 1, 3)));
      continue;
    }
    if (!connected) { connected = true; everOpened = true; setLinkError(''); setConnection('Connected', 'ok'); }
    errorsInRow = 0;
    setPresence(!!body.peerOnline);
    for (const item of body.events || []) {
      if (cursor != null && item.id <= cursor) continue;
      try { handlers[item.event]?.(item.data); } catch (error) { console.error(error); }
    }
    if (Number.isFinite(body.cursor)) cursor = body.cursor;
    refresh();
  }
}
function join() {
  hideError(); setLinkError('');
  if (!me) { setLinkError('Choose Aryan or Rohit first.'); return; }
  if (!token) { setLinkError(INVALID_LINK); return; }
  if (!window.fetch || !window.AudioContext || !window.MediaRecorder) { setLinkError('This browser can’t run the call. Use current Chrome, Safari, or Firefox.'); return; }
  lsSet('vf-call-as', me);
  joined = true; everOpened = false; errorsInRow = 0;
  // Unlock audio inside this click so incoming clips can play later.
  ctx ||= new AudioContext({ latencyHint: 'interactive' });
  ctx.resume().catch(() => {}); applySink();
  setConnection('Connecting…', 'wait'); setPresence(null); setStatus('Ready');
  openStream(); refresh();
  ensureMic().catch(error => {
    if (error.name === 'NotSupported') showError(error.message);
    else showError(`${micError(error)} You can still hear ${peerName()}.`);
  });
}
function teardownCall() {
  cancelRecording(); stopPlayback();
  queue.length = 0; turns.clear(); sentPending.length = 0;
  releaseMic();
  ctx?.close().catch(() => {}); ctx = null;
}
function leave() {
  stopConnection(); joined = false; connected = false;
  teardownCall();
  setConnection('Not joined', 'idle'); setPresence(null); setStatus('Join the call to talk'); hideError(); setLinkError('');
  refresh();
}

/* ---------- Sending: push to talk ---------- */
function beginTalk() {
  if (rec || talk.disabled) return;
  hideError();
  const run = rec = { pressedAt: performance.now(), chunks: [], released: false, cancelled: false };
  ctx?.resume().catch(() => {});
  setStatus('Listening', 'listening'); refresh();
  ensureMic().then(stream => {
    if (rec !== run || run.cancelled) return;
    if (run.released) return discard(run, 'Too short. Hold the button while you speak.');
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser has no supported recording format. Use current Chrome, Safari, or Firefox.');
    const recorder = run.recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32000 });
    recorder.ondataavailable = event => { if (event.data.size) run.chunks.push(event.data); };
    recorder.onerror = () => { if (rec === run) { discard(run, ''); showError('Recording failed. Try again.'); } };
    recorder.onstop = () => { clearTimeout(run.maxTimer); if (!run.cancelled && !run.discarded) sendRecording(run, mimeType); };
    recorder.start();
    run.maxTimer = setTimeout(() => endTalk(), MAX_RECORD_MS);
  }).catch(error => {
    if (rec !== run) return;
    rec = null; run.cancelled = true; setStatus('Ready'); refresh();
    showError(error.name === 'NotSupported' ? error.message : error.message?.startsWith('This browser') ? error.message : micError(error));
  });
}
function discard(run, message) {
  run.discarded = true; clearTimeout(run.maxTimer);
  if (run.recorder?.state === 'recording') run.recorder.stop();
  if (rec === run) rec = null;
  setStatus(message || 'Ready'); refresh();
}
function endTalk() {
  const run = rec; if (!run || run.released) return;
  run.released = true;
  if (!run.recorder) return; // microphone still opening: the start handler cleans up
  if (performance.now() - run.pressedAt < MIN_HOLD_MS) { discard(run, 'Too short. Hold the button while you speak.'); return; }
  run.recorder.stop(); // onstop sends
}
function cancelRecording() {
  const run = rec; if (!run) return;
  run.cancelled = true; clearTimeout(run.maxTimer);
  if (run.recorder?.state === 'recording') run.recorder.stop();
  rec = null; setStatus('Canceled. Nothing was sent.'); refresh();
}

async function sendRecording(run, mimeType) {
  rec = null;
  const blob = new Blob(run.chunks, { type: mimeType }); run.chunks = [];
  if (!blob.size) { setStatus('Nothing was recorded. Try again.', 'error'); refresh(); return; }
  sending = true; setStatus('Cleaning', 'processing'); refresh();
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 120000);
  const sentId = ++sentCounter;
  let entry = addEntry('you', '…', 'Transcribing', 'waiting'), cleanedText = '', finished = false;
  setText(entry, '…', true);
  try {
    const response = await fetch(withToken('/api/call/speak'), { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob, signal: abort.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || ''), { code: body.code, httpStatus: response.status });
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const handle = line => {
      const event = JSON.parse(line);
      if (event.type === 'status') {
        setStatus(`Cleaning · ${event.stage}`, 'processing');
        const mark = { transcribing: 'Transcribing', cleaning: 'Cleaning', speaking: 'Making your voice', sent: 'Sending' }[event.stage];
        if (entry && mark) setMark(entry, mark, 'waiting');
      } else if (event.type === 'preview') { if (entry && event.text) setText(entry, String(event.text), true); }
      else if (event.type === 'cleaned') {
        cleanedText = String(event.text || '').trim();
        if (cleanedText) { setText(entry, cleanedText); entry.id = event.id ?? null; }
        else { removeEntry(entry); entry = null; }
      } else if (event.type === 'error') throw Object.assign(new Error(event.error || ''), { code: event.code });
      else if (event.type === 'done') finished = true;
    };
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
        if (line) handle(line);
      }
      if (done) break;
    }
    if (pending.trim()) handle(pending.trim());
    if (!finished) throw Object.assign(new Error('dropped'), { dropped: true });
    if (!entry) setStatus('No speech heard. Hold the button and try again.');
    else {
      setMark(entry, `Sent. Waiting for ${peerName()}`, 'waiting'); sentPending.push(entry);
      setStatus('Sent', 'ready');
    }
  } catch (error) {
    const network = error instanceof TypeError || error.dropped;
    const text = error.name === 'AbortError' ? 'The server took too long. Try a shorter message.'
      : network ? (navigator.onLine === false ? 'You’re offline. Reconnect to the internet, then try again.' : 'Can’t reach the call server. Check your connection and try again.')
      : describeFailure(error.message, error.code, error.httpStatus);
    if (entry) { if (!cleanedText) setText(entry, 'Message not sent.'); setMark(entry, 'Not delivered', 'failed'); }
    if (text === INVALID_LINK) { invalidLink(); showError(text); }
    else { setStatus('Not sent', 'error'); showError(text); }
  } finally { clearTimeout(timeout); sending = false; refresh(); }
}

/* ---------- Receiving: captions and clips ---------- */
function turnFor(id) {
  let turn = turns.get(id);
  if (!turn) {
    turn = { id, clips: new Map(), played: 0, of: 0, last: null, done: false, failed: false, createdAt: performance.now() };
    turns.set(id, turn); queue.push(turn);
  }
  return turn;
}
function onCaption(data) {
  if (data.id == null || pick(data.from) === me || turns.has(data.id)) return;
  const turn = turnFor(data.id);
  turn.entry = addEntry('peer', String(data.text || ''), 'Waiting', 'waiting');
  refresh(); pump();
}
function onClip(data) {
  if (data.id == null || pick(data.from) === me) return;
  const turn = turnFor(data.id);
  if (!turn.entry) turn.entry = addEntry('peer', 'Voice message', 'Waiting', 'waiting');
  if (turn.clips.has(data.seq) || turn.done) return;
  turn.clips.set(data.seq, data);
  turn.firstClipAt ??= performance.now();
  turn.of = Math.max(turn.of, Number(data.of) || 0);
  refresh(); pump();
}
function onDelivered(data) {
  const entry = sentPending.find(item => item.id != null && item.id === data.id) || sentPending[0];
  if (!entry) return;
  sentPending.splice(sentPending.indexOf(entry), 1);
  setMark(entry, `Heard by ${peerName()}`, 'heard');
  if (!sending && !rec && !incomingBusy()) setStatus(`Heard by ${peerName()}`, 'done');
}
function onRelayError(data) {
  const text = describeFailure(data.message, data.code);
  if (pick(data.from) === me || (data.id != null && sentPending.some(item => item.id === data.id))) {
    const entry = sentPending.find(item => item.id === data.id) || sentPending.shift();
    if (entry) { sentPending.splice(sentPending.indexOf(entry), 1); setMark(entry, 'Not delivered', 'failed'); }
    setStatus('Not delivered', 'error'); showError(text); return;
  }
  const turn = turns.get(data.id);
  if (turn && !turn.done) { turn.failed = true; finishTurn(turn, 'Couldn’t play', 'failed'); }
  showError(`${peerName()}’s message couldn’t be played. ${text}`);
}
function finishTurn(turn, mark, state) {
  turn.done = true; setMark(turn.entry, mark, state);
  const at = queue.indexOf(turn); if (at >= 0 && queue.every(item => item.done)) queue.length = 0;
  refresh();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (!joined) break;
      if (rec) { await sleep(200); continue; } // never talk over your own recording
      const turn = queue.find(item => !item.done);
      if (!turn) break;
      await playTurn(turn);
    }
  } finally { pumping = false; refresh(); }
}
async function nextClip(turn) {
  const deadline = performance.now() + (turn.last == null ? 30000 : 15000);
  for (;;) {
    if (turn.failed || turn.done || !joined) return null;
    let want;
    if (turn.last != null) want = turn.last + 1;
    else if (turn.clips.has(0)) want = 0;
    else if (turn.of === 1 && turn.clips.has(1)) want = 1;
    else if (turn.clips.size && performance.now() - turn.firstClipAt > 1500) want = Math.min(...turn.clips.keys());
    if (want !== undefined && turn.clips.has(want)) return turn.clips.get(want);
    if (performance.now() > deadline) return null;
    await sleep(100);
  }
}
async function playTurn(turn) {
  let ok = true;
  while (!turn.of || turn.played < turn.of) {
    const clip = await nextClip(turn);
    if (!joined) return;
    if (!clip) { ok = false; break; }
    try {
      await playClip(clip, () => setMark(turn.entry, 'Speaking', 'speaking'));
    } catch (error) {
      if (!joined) return;
      ok = false; break;
    }
    turn.played++; turn.last = clip.seq;
  }
  if (!joined || turn.done) return;
  if (!ok) {
    finishTurn(turn, 'Couldn’t play', 'failed');
    showError(`${peerName()} said something, but it couldn’t be played. Ask them to say it again.`);
    return;
  }
  finishTurn(turn, 'Heard', 'heard');
  ack(turn.id);
}
async function ack(id) {
  for (let attempt = 0; attempt < 4 && joined; attempt++) {
    try {
      const response = await fetch(withToken('/api/call/ack'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (response.ok || response.status === 401) return;
    } catch {}
    await sleep(500 * 2 ** attempt);
  }
}

async function fetchClip(clip) {
  const url = new URL(clip.url, location.origin);
  if (url.origin !== location.origin) throw new Error('Clip is from another site.');
  if (!url.searchParams.has('t')) url.searchParams.set('t', token);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.status === 401) { invalidLink(); throw new Error('unauthorized'); }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (error) { lastError = error; if (!joined) throw error; await sleep(400 * (attempt + 1)); }
  }
  throw lastError;
}
async function playClip(clip, onStart) {
  const bytes = await fetchClip(clip);
  if (!joined) throw new Error('left');
  await ensureRunning();
  if (!joined) throw new Error('left');
  let buffer;
  try { buffer = await ctx.decodeAudioData(bytes.slice(0)); } catch { buffer = null; }
  onStart();
  if (buffer) {
    await new Promise(resolve => {
      const node = ctx.createBufferSource(); node.buffer = buffer; node.connect(ctx.destination);
      currentSource = node;
      const finish = () => { clearTimeout(guard); node.disconnect(); if (currentSource === node) currentSource = null; resolve(); };
      const guard = setTimeout(finish, buffer.duration * 1000 + 10000);
      node.onended = finish; node.start();
    });
    return;
  }
  // Format the Web Audio decoder refused: let an audio element try it.
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: clip.mime || 'audio/mpeg' }));
  const audio = currentAudio = new Audio(objectUrl);
  if (speakerId && audio.setSinkId) await audio.setSinkId(speakerId).catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      audio.onended = resolve; audio.onerror = () => reject(new Error('This browser can’t play the audio.'));
      audio.play().catch(reject);
    });
  } finally { URL.revokeObjectURL(objectUrl); if (currentAudio === audio) currentAudio = null; }
}
function stopPlayback() {
  gateRelease?.(); enableBtn.hidden = true;
  try { currentSource?.stop(); } catch {}
  currentSource = null; currentAudio?.pause(); currentAudio = null;
}

/* ---------- Wiring ---------- */
document.querySelectorAll('input[name="who"]').forEach(input => input.addEventListener('change', () => {
  me = input.value; lsSet('vf-call-as', me); setLinkError('');
}));
joinBtn.addEventListener('click', join);
leaveBtn.addEventListener('click', leave);
cancel.addEventListener('click', cancelRecording);

talk.addEventListener('pointerdown', event => {
  if (event.button !== 0 || rec) return;
  event.preventDefault(); talk.focus(); talk.setPointerCapture(event.pointerId); beginTalk();
});
talk.addEventListener('pointerup', endTalk);
talk.addEventListener('pointercancel', cancelRecording);
talk.addEventListener('lostpointercapture', endTalk);
talk.addEventListener('contextmenu', event => event.preventDefault());
// Space works on the focused button and anywhere on the page that isn't another control.
const spaceTarget = event => event.target === talk || event.target === document.body || event.target === $('main') || event.target === $('log');
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (rec) cancelRecording(); return; }
  if (event.code !== 'Space' || !spaceTarget(event)) return;
  event.preventDefault();
  if (!event.repeat) beginTalk();
});
window.addEventListener('keyup', event => {
  if (event.code !== 'Space' || !rec) return;
  event.preventDefault(); endTalk();
});
window.addEventListener('blur', () => { if (rec) cancelRecording(); });
window.addEventListener('pagehide', () => { stopConnection(); releaseMic(); });
window.addEventListener('online', () => { if (joined && !connected) openStream(); });

$('micSelect').addEventListener('change', event => {
  micId = event.target.value; lsSet('vf-call-mic', micId);
  releaseMic(); if (joined) ensureMic().catch(error => showError(micError(error)));
});
$('speakerSelect').addEventListener('change', event => {
  speakerId = event.target.value; lsSet('vf-call-speaker', speakerId); applySink();
});
$('listDevices').addEventListener('click', () => {
  hideError();
  ensureMic().then(listDevices).catch(error => { $('deviceNote').textContent = micError(error); });
});
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);

if (!window.isSecureContext) setLinkError('The microphone only works on localhost or HTTPS. Open the call from the link you were given.');
else if (!token) { setLinkError(INVALID_LINK); joinBtn.disabled = true; }
listDevices();
refresh();
