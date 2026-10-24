// Comms page: sign in, a DM with voice messages (speech -> polished text), and a
// joinable voice call (push-to-talk, heard in the speaker's cloned voice).
// Talks to /api/call/* only. Playback is a small copy of the decode-and-schedule
// idea in playback.js (which stays untouched); each clip is fetched by URL.
const $ = id => document.getElementById(id);
const talk = $('talk'), record = $('record'), cancel = $('cancel'), joinBtn = $('join'), leaveBtn = $('leave'), enableBtn = $('enable');
const NAMES = { aryan: 'Aryan', rohit: 'Rohit' };
// Demo accounts, checked in the page only. The link's token still guards the server.
const ACCOUNTS = { aryan: '1234', rohit: '4321' };
const MIN_HOLD_MS = 300, MAX_RECORD_MS = 60000;
const INVALID_LINK = 'This link isn’t valid. Ask for a new one.';

const params = new URLSearchParams(location.search);
const token = params.get('t') || ''; // kept in memory only; never rendered
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ssGet = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const ssSet = (key, value) => { try { value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch {} };
const lsGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
const lsSet = (key, value) => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} };
const pick = value => (value = String(value || '').toLowerCase().trim()) in NAMES ? value : '';

let me = '';
let signedIn = false, connected = false, everOpened = false, errorsInRow = 0;
let inCall = false, peerInCall = false, peerOnline = false;
let connectId = 0, pollAbort;
let ctx, micStream, micPromise, micId = lsGet('vf-call-mic') || '', speakerId = lsGet('vf-call-speaker') || '';
let rec = null, sending = false, pumping = false, currentSource, currentAudio, gateRelease;
const turns = new Map();   // utterance id -> { id, entry, clips, ... }
const queue = [];          // peer call utterances in arrival order
const sentPending = [];    // my call utterances waiting for "delivered"

const peerOf = who => (who === 'aryan' ? 'rohit' : 'aryan');
const peerName = () => NAMES[peerOf(me)] || 'the other person';
const initial = who => (NAMES[who] || '?')[0];

/* ---------- Status and errors ---------- */
function setStatus(text, state = 'ready') { $('statusText').textContent = text; $('status').dataset.state = state; }
function showError(text) { $('error').textContent = text; $('error').hidden = false; }
function hideError() { $('error').hidden = true; $('error').textContent = ''; }
function setLinkError(text) { $('linkError').textContent = text || ''; $('linkError').hidden = !text; }
function setConnection(text, state) { $('connection').textContent = text; $('connection').dataset.state = state; }
function setAvatar(el, who) { el.textContent = initial(who); el.dataset.who = who; }

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
  if (id === 'peer_offline') return `${peerName()} isn’t signed in. Ask them to open the link and sign in, then try again.`;
  if (id === 'call_line_cap' || id === 'twinly_not_configured' || id === 'missing_keys' || id === 'call_not_configured') return `${sentence} Ask the host to fix it.`;
  if (httpStatus === 413 || /audio_limit|too (large|long|big)/.test(text)) return 'That was too long to send. Hold the button for a shorter message.';
  if (id === 'empty_audio') return 'No sound was recorded. Check your microphone and try again.';
  if (id === 'timeout') return 'That took too long. Try a shorter message.';
  if (/needs_approval|approval|declined|not_allowed|stopped_by_owner/.test(text)) return 'Twinly needs approval before it can speak in your voice. Open Twinly on the host Mac, approve the voice request, then try again.';
  if (/rate_limited|rate limit|plan_limit|key_cap|insufficient_usage|free_prompts/.test(text) || httpStatus === 429) return 'Twinly is rate limited or out of usage. Wait a minute, or ask the host to check the plan, then try again.';
  if (/twinly_offline|voice_starting|queue_timeout|econnrefused|twinly.*(offline|unreachable)/.test(text)) return 'Twinly is offline, so your voice can’t be generated. Open Twinly on the host Mac, keep it awake, then try again.';
  if (message) return `${sentence} Try again.`;
  return httpStatus >= 500 ? 'The server had a problem. Try again in a moment.' : 'Something went wrong. Try again.';
}

/* ---------- Layout state ---------- */
const incomingBusy = () => queue.some(turn => !turn.done);
function refresh() {
  const playing = incomingBusy();
  const peer = peerName();

  // Presence: sidebar, header, call tiles.
  const state = !connected ? 'offline' : peerInCall ? 'call' : peerOnline ? 'online' : 'offline';
  const words = { offline: 'Offline', online: 'Online', call: 'In the call' }[state];
  $('peerDot').dataset.state = state; $('peerState').textContent = words; $('peerState').dataset.state = state;
  $('presence').dataset.state = state;
  $('presenceText').textContent = state === 'call' ? (inCall ? `${peer} is in the call with you` : `${peer} is in the call. Join them.`) : words;
  $('tilePeer').dataset.state = playing && inCall ? 'speaking' : peerInCall ? 'in' : 'out';
  $('tilePeerState').textContent = playing && inCall ? 'Speaking' : peerInCall ? 'In call' : 'Not joined';
  $('tileMe').dataset.state = rec?.kind === 'call' ? 'speaking' : 'in';

  // Call controls.
  joinBtn.hidden = inCall; leaveBtn.hidden = !inCall; $('callPanel').hidden = !inCall;
  joinBtn.disabled = !connected;
  let label = 'Hold to Talk', reason = '', keys = true, disabled = false;
  if (!connected) { disabled = true; reason = 'Reconnecting. You can talk again once the call is back.'; keys = false; }
  else if (rec?.kind === 'call') { label = 'Release to send'; reason = 'Release to send, or press Esc to cancel.'; keys = false; }
  else if (!peerInCall) { disabled = true; reason = `Waiting for ${peer} to join the call.`; keys = false; }
  else if (rec || sending) { disabled = true; label = sending ? 'Sending…' : 'Hold to Talk'; reason = 'Finish your other message first.'; keys = false; }
  else if (playing) { disabled = true; label = `${peer} is speaking`; reason = `Waiting for ${peer} to finish. One voice at a time.`; keys = false; }
  talk.disabled = disabled;
  $('talkLabel').textContent = label;
  talk.dataset.held = rec?.kind === 'call' ? 'true' : 'false';
  talk.setAttribute('aria-label', rec?.kind === 'call' ? 'Recording. Release to send.' : disabled ? `${label}. ${reason}` : 'Hold to talk. Release to send.');
  $('hintText').textContent = reason; $('hintText').hidden = !reason; $('hintKeys').hidden = !keys;
  cancel.disabled = !rec;
  if (inCall && !rec && !sending) {
    if (!connected) setStatus('Reconnecting', 'processing');
    else if (playing) setStatus(`${peer} is speaking`, 'speaking');
    else if (!peerInCall) setStatus(`Waiting for ${peer}`, 'processing');
    else if (['Reconnecting', `${peer} is speaking`, `Waiting for ${peer}`].includes($('statusText').textContent)) setStatus('Ready');
  }

  // Voice message composer.
  const held = rec?.kind === 'message';
  record.disabled = !connected || (!!rec && !held) || sending || !peerOnline;
  record.dataset.held = held ? 'true' : 'false';
  $('recordLabel').textContent = held ? 'Release to send' : sending && !rec ? 'Polishing…' : 'Hold to record a voice message';
  $('composerHint').textContent = !connected ? '' : !peerOnline ? `${peer} is offline. Voice messages send once they sign in.`
    : held ? 'Release to send, or press Esc to cancel.'
    : `Becomes polished text for ${peer}.${inCall ? '' : ' Or hold Space.'}`;
}

/* ---------- Thread ---------- */
const log = $('log');
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
function countEntries() {
  const count = log.children.length;
  $('logState').textContent = count ? `${count} message${count === 1 ? '' : 's'}` : 'No messages yet';
}
// One message row: avatar, name, time and kind, the words, then a status line.
function addEntry(who, text, mark, markState, kind = 'message') {
  const follow = nearBottom();
  const author = who === 'you' ? me : peerOf(me);
  const li = document.createElement('li'); li.className = 'turn'; li.dataset.who = who; li.dataset.kind = kind;
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true'); setAvatar(avatar, author);
  const meta = document.createElement('p'); meta.className = 'meta';
  const label = document.createElement('span'); label.className = 'who'; label.textContent = NAMES[author];
  const time = document.createElement('time'); const at = new Date();
  time.dateTime = at.toISOString(); time.textContent = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tag = document.createElement('span'); tag.className = 'kind'; tag.dataset.kind = kind; tag.textContent = kind === 'call' ? 'In call · cloned voice' : 'Voice message';
  meta.append(label, time, tag);
  const said = document.createElement('p'); said.className = 'said'; said.textContent = text;
  const markEl = document.createElement('span'); markEl.className = 'flag';
  li.append(avatar, meta, said, markEl); log.append(li);
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
function setMark(entry, text, state = '') {
  if (!entry) return;
  entry.markEl.textContent = text; entry.markEl.dataset.state = state;
}
function removeEntry(entry) { entry?.li.remove(); countEntries(); }

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
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error('The microphone needs HTTPS or localhost and a current browser.'), { name: 'NotSupported' }));
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
  $('speakerSelect').disabled = !!ctx && !ctx.setSinkId;
  $('deviceNote').textContent = ctx && !ctx.setSinkId ? 'This browser plays through your system output. Change the speaker in system sound settings.' : '';
}

/* ---------- Connection ---------- */
const withToken = path => `${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(me)}&t=${encodeURIComponent(token)}`;
const postJson = (path, body) => fetch(withToken(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function invalidLink() {
  stopConnection(); connected = false;
  setConnection('Link not valid', 'error');
  setLinkError(INVALID_LINK);
  endCall(false); refresh();
}
function stopConnection() { connectId++; pollAbort?.abort(); pollAbort = null; }
// Long-poll /api/call/poll instead of SSE: tunnels such as cloudflared quick
// tunnels buffer an event stream until it closes, so nothing would arrive.
const handlers = { caption: onCaption, clip: onClip, delivered: onDelivered, error: onRelayError, message: onMessage,
  voice: data => { peerInCall = !!data.in; refresh(); } };
async function openStream() {
  const id = ++connectId;
  let cursor = null;
  while (signedIn && id === connectId) {
    const abort = pollAbort = new AbortController(), timer = setTimeout(() => abort.abort(), 40000);
    let body = null, status = 0;
    try {
      const response = await fetch(withToken(cursor == null ? '/api/call/poll' : `/api/call/poll?after=${cursor}`), { cache: 'no-store', signal: abort.signal });
      status = response.status;
      if (response.ok) body = await response.json();
    } catch {} finally { clearTimeout(timer); }
    if (!signedIn || id !== connectId) return;
    if (status === 401) { invalidLink(); return; }
    if (!body) {
      connected = false; errorsInRow++;
      setConnection(everOpened ? 'Reconnecting…' : 'Connecting…', 'wait'); refresh();
      if (status === 403) setLinkError(describeFailure('', 'BAD_ORIGIN', 403));
      else if (status >= 400 && status < 500) setLinkError('The server rejected the connection. Reload the page, or ask for a new link.');
      else if (errorsInRow >= 3) setLinkError('Can’t reach the server. Check your connection. This page keeps trying.');
      await sleep(Math.min(8000, 1000 * 2 ** Math.min(errorsInRow - 1, 3)));
      continue;
    }
    if (!connected) { connected = true; everOpened = true; setLinkError(''); setConnection('Online', 'ok'); }
    errorsInRow = 0;
    peerOnline = !!body.peerOnline; peerInCall = !!body.peerInVoice;
    // The server forgot we were in the call (restart or long drop): tell it again.
    if (inCall && body.inVoice === false) postJson('/api/call/voice', { in: true }).catch(() => {});
    for (const item of body.events || []) {
      if (cursor != null && item.id <= cursor) continue;
      try { handlers[item.event]?.(item.data); } catch (error) { console.error(error); }
    }
    if (Number.isFinite(body.cursor)) cursor = body.cursor;
    refresh();
  }
}

/* ---------- Sign in / out ---------- */
function showLogin(message = '') {
  $('app').hidden = true; $('login').hidden = false;
  $('loginError').textContent = message; $('loginError').hidden = !message;
  document.title = 'Sign in · Sugarcoat Comms';
}
function enterApp(who) {
  me = who; signedIn = true; everOpened = false; errorsInRow = 0; connected = false;
  ssSet('vf-comms-user', me);
  const peer = peerOf(me);
  $('login').hidden = true; $('app').hidden = false;
  document.title = `@${NAMES[peer]} · Sugarcoat Comms`;
  $('meName').textContent = NAMES[me]; setAvatar($('meAvatar'), me);
  $('peerNameRail').textContent = NAMES[peer]; setAvatar($('peerAvatar'), peer);
  $('dmTitle').textContent = NAMES[peer]; $('emptyTitle').textContent = `This is the start of your conversation with ${NAMES[peer]}.`;
  setAvatar($('emptyAvatar'), peer);
  $('tileMeName').textContent = `${NAMES[me]} (you)`; setAvatar($('tileMeAvatar'), me);
  $('tilePeerName').textContent = NAMES[peer]; setAvatar($('tilePeerAvatar'), peer);
  setConnection('Connecting…', 'wait');
  if (!window.fetch || !window.AudioContext || !window.MediaRecorder) setLinkError('This browser can’t run calls. Use current Chrome, Safari, or Firefox.');
  else if (!window.isSecureContext) setLinkError('The microphone only works on localhost or HTTPS. Open the link you were given.');
  openStream(); refresh();
}
function signIn(event) {
  event.preventDefault();
  if (!token) { showLogin(INVALID_LINK); return; }
  const who = pick($('username').value), password = $('password').value;
  if (!who || ACCOUNTS[who] !== password) { showLogin('Wrong username or password.'); $('password').select(); return; }
  $('password').value = '';
  // This click can unlock audio, so incoming voices play later.
  ctx ||= new AudioContext({ latencyHint: 'interactive' });
  ctx.resume().catch(() => {}); applySink();
  enterApp(who);
}
function logout() {
  endCall(true);
  stopConnection(); signedIn = false; connected = false; peerOnline = false; peerInCall = false;
  cancelRecording(); releaseMic();
  log.replaceChildren(); countEntries(); hideError(); setLinkError('');
  ctx?.close().catch(() => {}); ctx = null;
  ssSet('vf-comms-user', '');
  $('username').value = ''; showLogin();
  $('username').focus();
}

/* ---------- Voice call ---------- */
async function joinCall() {
  hideError();
  ctx ||= new AudioContext({ latencyHint: 'interactive' });
  ctx.resume().catch(() => {}); applySink();
  joinBtn.disabled = true;
  try {
    const response = await postJson('/api/call/voice', { in: true });
    if (response.status === 401) { invalidLink(); return; }
    if (!response.ok) throw new Error();
    const body = await response.json();
    inCall = true; peerInCall = !!body.peerInVoice;
    setStatus(peerInCall ? 'Ready' : `Waiting for ${peerName()}`, peerInCall ? 'ready' : 'processing');
    ensureMic().catch(error => showError(error.name === 'NotSupported' ? error.message : `${micError(error)} You can still hear ${peerName()}.`));
  } catch { showError('Couldn’t join the call. Try again.'); }
  finally { refresh(); }
}
function endCall(tellServer) {
  if (rec?.kind === 'call') cancelRecording();
  stopPlayback();
  for (const turn of queue) if (!turn.done) { turn.done = true; setMark(turn.entry, 'Left before it played', 'failed'); }
  queue.length = 0;
  const wasIn = inCall; inCall = false;
  if (wasIn && tellServer) postJson('/api/call/voice', { in: false }).catch(() => {});
  refresh();
}

/* ---------- Sending: push to talk (call) and hold to record (message) ---------- */
function beginTalk(kind) {
  if (rec) return;
  if (kind === 'call' ? talk.disabled : record.disabled) return;
  hideError();
  const run = rec = { kind, pressedAt: performance.now(), chunks: [], released: false, cancelled: false };
  ctx?.resume().catch(() => {});
  if (kind === 'call') setStatus('Listening', 'listening');
  refresh();
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
    rec = null; run.cancelled = true; if (kind === 'call') setStatus('Ready'); refresh();
    showError(error.name === 'NotSupported' ? error.message : error.message?.startsWith('This browser') ? error.message : micError(error));
  });
}
function discard(run, message) {
  run.discarded = true; clearTimeout(run.maxTimer);
  if (run.recorder?.state === 'recording') run.recorder.stop();
  if (rec === run) rec = null;
  if (run.kind === 'call') setStatus(message || 'Ready');
  else if (message) showError(message);
  refresh();
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
  rec = null;
  if (run.kind === 'call') setStatus('Canceled. Nothing was sent.');
  refresh();
}

async function sendRecording(run, mimeType) {
  rec = null;
  const isCall = run.kind === 'call';
  const blob = new Blob(run.chunks, { type: mimeType }); run.chunks = [];
  if (!blob.size) { showError('Nothing was recorded. Try again.'); refresh(); return; }
  sending = true; if (isCall) setStatus('Cleaning', 'processing'); refresh();
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 120000);
  let entry = addEntry('you', '…', 'Transcribing', 'waiting', run.kind), cleanedText = '', finished = false;
  setText(entry, '…', true);
  try {
    const response = await fetch(withToken(isCall ? '/api/call/speak' : '/api/call/message'), { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob, signal: abort.signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error || ''), { code: body.code, httpStatus: response.status });
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    const handle = line => {
      const event = JSON.parse(line);
      if (event.type === 'status') {
        if (isCall) setStatus(`Cleaning · ${event.stage}`, 'processing');
        const mark = { transcribing: 'Transcribing', cleaning: 'Polishing', speaking: 'Making your voice', sent: 'Sending' }[event.stage];
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
    if (!entry) { if (isCall) setStatus('No speech heard. Hold the button and try again.'); else showError('No speech heard. Hold the button and try again.'); }
    else if (isCall) { setMark(entry, `Sent. Waiting for ${peerName()}`, 'waiting'); sentPending.push(entry); setStatus('Sent', 'ready'); }
    else setMark(entry, `Delivered to ${peerName()}`, 'heard');
  } catch (error) {
    const network = error instanceof TypeError || error.dropped;
    const text = error.name === 'AbortError' ? 'The server took too long. Try a shorter message.'
      : network ? (navigator.onLine === false ? 'You’re offline. Reconnect to the internet, then try again.' : 'Can’t reach the server. Check your connection and try again.')
      : describeFailure(error.message, error.code, error.httpStatus);
    if (entry) { if (!cleanedText) setText(entry, 'Message not sent.'); setMark(entry, 'Not delivered', 'failed'); }
    if (text === INVALID_LINK) invalidLink();
    if (isCall) setStatus('Not sent', 'error');
    showError(text);
  } finally { clearTimeout(timeout); sending = false; refresh(); }
}

/* ---------- Receiving: messages, captions and clips ---------- */
function onMessage(data) {
  if (pick(data.from) === me) return;
  addEntry('peer', String(data.text || ''), '', '', 'message');
}
function turnFor(id) {
  let turn = turns.get(id);
  if (!turn) {
    turn = { id, clips: new Map(), played: 0, of: 0, last: null, done: false, failed: false, createdAt: performance.now() };
    turns.set(id, turn);
    if (inCall) queue.push(turn); else turn.done = true;
  }
  return turn;
}
function onCaption(data) {
  if (data.id == null || pick(data.from) === me || turns.has(data.id)) return;
  const turn = turnFor(data.id);
  turn.entry = addEntry('peer', String(data.text || ''), inCall ? 'Waiting' : 'Said in the call', inCall ? 'waiting' : '', 'call');
  refresh(); pump();
}
function onClip(data) {
  if (data.id == null || pick(data.from) === me) return;
  const turn = turnFor(data.id);
  if (!turn.entry) turn.entry = addEntry('peer', 'Voice message', 'Waiting', 'waiting', 'call');
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
  if (inCall && !sending && !rec && !incomingBusy()) setStatus(`Heard by ${peerName()}`, 'done');
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
  if (queue.every(item => item.done)) queue.length = 0;
  refresh();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (!inCall) break;
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
    if (turn.failed || turn.done || !inCall) return null;
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
    if (!inCall) return;
    if (!clip) { ok = false; break; }
    try {
      await playClip(clip, () => setMark(turn.entry, 'Speaking', 'speaking'));
    } catch (error) {
      if (!inCall) return;
      ok = false; break;
    }
    turn.played++; turn.last = clip.seq;
  }
  if (!inCall || turn.done) return;
  if (!ok) {
    finishTurn(turn, 'Couldn’t play', 'failed');
    showError(`${peerName()} said something, but it couldn’t be played. Ask them to say it again.`);
    return;
  }
  finishTurn(turn, 'Heard', 'heard');
  ack(turn.id);
}
async function ack(id) {
  for (let attempt = 0; attempt < 4 && signedIn; attempt++) {
    try {
      const response = await postJson('/api/call/ack', { id });
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
    } catch (error) { lastError = error; if (!inCall) throw error; await sleep(400 * (attempt + 1)); }
  }
  throw lastError;
}
async function playClip(clip, onStart) {
  const bytes = await fetchClip(clip);
  if (!inCall) throw new Error('left');
  ctx ||= new AudioContext({ latencyHint: 'interactive' });
  await ensureRunning();
  if (!inCall) throw new Error('left');
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
$('loginForm').addEventListener('submit', signIn);
$('logout').addEventListener('click', logout);
joinBtn.addEventListener('click', joinCall);
leaveBtn.addEventListener('click', () => { endCall(true); setStatus('Ready'); });
cancel.addEventListener('click', cancelRecording);

for (const [button, kind] of [[talk, 'call'], [record, 'message']]) {
  button.addEventListener('pointerdown', event => {
    if (event.button !== 0 || rec) return;
    event.preventDefault(); button.focus(); button.setPointerCapture(event.pointerId); beginTalk(kind);
  });
  button.addEventListener('pointerup', endTalk);
  button.addEventListener('pointercancel', cancelRecording);
  button.addEventListener('lostpointercapture', endTalk);
  button.addEventListener('contextmenu', event => event.preventDefault());
}
// Space talks in the call while you're in it, otherwise it records a voice message.
// It works on the focused button and anywhere on the page that isn't another control.
const spaceTarget = event => [talk, record, document.body, $('app'), log].includes(event.target);
window.addEventListener('keydown', event => {
  if (!signedIn) return;
  if (event.key === 'Escape') { if (rec) cancelRecording(); return; }
  if (event.code !== 'Space' || !spaceTarget(event)) return;
  event.preventDefault();
  if (!event.repeat) beginTalk(event.target === record ? 'message' : event.target === talk || inCall ? 'call' : 'message');
});
window.addEventListener('keyup', event => {
  if (event.code !== 'Space' || !rec) return;
  event.preventDefault(); endTalk();
});
window.addEventListener('blur', () => { if (rec) cancelRecording(); });
window.addEventListener('pagehide', () => { stopConnection(); releaseMic(); });
window.addEventListener('online', () => { if (signedIn && !connected) openStream(); });

$('micSelect').addEventListener('change', event => {
  micId = event.target.value; lsSet('vf-call-mic', micId);
  releaseMic(); if (inCall) ensureMic().catch(error => showError(micError(error)));
});
$('speakerSelect').addEventListener('change', event => {
  speakerId = event.target.value; lsSet('vf-call-speaker', speakerId); applySink();
});
$('listDevices').addEventListener('click', () => {
  hideError();
  ensureMic().then(listDevices).catch(error => { $('deviceNote').textContent = micError(error); });
});
navigator.mediaDevices?.addEventListener?.('devicechange', listDevices);

// Start: a legacy ?as= link (tools and tests) or a remembered session skips the sign-in.
const preset = pick(params.get('as')) || pick(ssGet('vf-comms-user'));
if (!token) { showLogin(INVALID_LINK); $('signIn').disabled = true; }
else if (preset) enterApp(preset);
else { showLogin(); $('username').focus(); }
listDevices();
