// Comms page: sign in, a DM with voice messages (speech -> polished text), and a
// joinable voice call (push-to-talk, heard in the speaker's cloned voice).
// Talks to /api/call/* only. Playback is a small copy of the decode-and-schedule
// idea in playback.js (which stays untouched); each clip is fetched by URL.
import { getSession, signIn as accountSignIn, signOut, accessToken, authFetch } from '/auth.js';
const $ = id => document.getElementById(id);
const talk = $('talk'), record = $('record'), joinBtn = $('join'), leaveBtn = $('leave'), enableBtn = $('enable');
const NAMES = { aryan: 'Aryan', rohit: 'Rohit' };
// Test contacts in the sidebar: a sandbox that is always online and never replies.
// In a call, your own line comes back in your cloned voice, so you can check Twinly.
const CONTACTS = { maya: 'Maya Chen', jordan: 'Jordan Alvarez', priya: 'Priya Nair', dev: 'Dev Team', sam: 'Sam Okafor', leah: 'Leah Brooks' };
const TONES = { maya: 1, jordan: 2, priya: 3, dev: 4, sam: 5, leah: 6 };
const isContact = who => Object.hasOwn(CONTACTS, who);
const nameOf = who => NAMES[who] || CONTACTS[who] || 'the other person';
// Demo accounts, checked in the page only. The link's token still guards the server.
const ACCOUNTS = { aryan: '1234', rohit: '4321' };
const MIN_HOLD_MS = 300, MAX_RECORD_MS = 60000;
const INVALID_LINK = 'This link isn’t valid. Ask for a new one.';

const params = new URLSearchParams(location.search);
const token = params.get('t') || ''; // kept in memory only; never rendered
// Accounts (Supabase) are on when the server says so. A legacy ?as=&t= link (tools, tests) still uses the token.
const accounts = await fetch('/api/config').then(r => (r.ok ? r.json() : {})).then(c => !!c.auth).catch(() => false);
const legacyLink = !!(token && params.get('as'));
let viaSession = false; // this page is signed in with an account rather than the token link
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ssGet = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
const ssSet = (key, value) => { try { value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch {} };
const lsGet = key => { try { return localStorage.getItem(key); } catch { return null; } };
const lsSet = (key, value) => { try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch {} };
const pick = value => (value = String(value || '').toLowerCase().trim()) in NAMES ? value : '';

let me = '';
let chat = ''; // the open conversation: the peer's name or a test contact
let signedIn = false, connected = false, everOpened = false, errorsInRow = 0;
let inCall = false, peerInCall = false, peerOnline = false;
let connectId = 0, pollAbort;
let ctx, micStream, micPromise, micId = lsGet('vf-call-mic') || '', speakerId = lsGet('vf-call-speaker') || '';
let rec = null, sending = false, pumping = false, currentSource, currentAudio, gateRelease;
const turns = new Map();   // utterance id -> { id, entry, clips, ... }
const queue = [];          // peer call utterances in arrival order
const sentPending = [];    // my call utterances waiting for "delivered"
const ownEntries = new Map(); // my utterance id -> its entry (test contacts play it back to me)

const peerOf = who => (who === 'aryan' ? 'rohit' : 'aryan');
const peerName = () => nameOf(chat || peerOf(me));
const initial = who => (NAMES[who] || CONTACTS[who] || '?')[0];
const chatOnline = () => isContact(chat) || peerOnline;
const chatInCall = () => (isContact(chat) ? inCall : peerInCall);

/* ---------- Status and errors ---------- */
// The call status shows under the other person's name in their call card.
let statusRaw = 'Ready';
function setStatus(text, state = 'ready') {
  statusRaw = text;
  const peer = peerName();
  $('statusText').textContent = text === 'Ready' ? 'In call' : text === `${peer} is speaking` ? 'Speaking'
    : text === `Waiting for ${peer}` ? 'Not joined yet' : text;
  $('status').dataset.state = state;
}
function showError(text) { $('error').textContent = text; $('error').hidden = false; }
function hideError() { $('error').hidden = true; $('error').textContent = ''; }
function setLinkError(text) { $('linkError').textContent = text || ''; $('linkError').hidden = !text; }
function setConnection(text, state) { $('connection').textContent = text; $('connection').dataset.state = state; }
function setAvatar(el, who) { el.textContent = initial(who); el.dataset.who = who; el.dataset.tone = TONES[who] || ''; }

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

  // Presence: sidebar (the real peer), header and call tiles (the open chat).
  const words = { offline: 'Offline', online: 'Online', call: 'In the call' };
  const peerState = !connected ? 'offline' : peerInCall ? 'call' : peerOnline ? 'online' : 'offline';
  $('peerDot').dataset.state = peerState; $('peerState').textContent = words[peerState]; $('peerState').dataset.state = peerState;
  const state = !connected ? 'offline' : chatInCall() ? 'call' : chatOnline() ? 'online' : 'offline';
  $('presence').dataset.state = state;
  $('presenceText').textContent = state === 'call' ? (inCall ? `${peer} is in the call with you` : `${peer} is in the call. Join them.`)
    : isContact(chat) && state === 'online' ? 'Test contact · always online' : words[state];
  $('tilePeer').dataset.state = playing && inCall ? 'speaking' : chatInCall() ? 'in' : 'out';
  $('tileMe').dataset.state = rec?.kind === 'call' ? 'speaking' : 'in';

  // Call controls.
  joinBtn.hidden = inCall; leaveBtn.hidden = !inCall; $('callPanel').hidden = !inCall;
  joinBtn.disabled = !connected;
  let label = 'Hold to talk', reason = '', disabled = false;
  if (!connected) { disabled = true; reason = 'Reconnecting. You can talk again once the call is back.'; }
  else if (rec?.kind === 'call') { label = 'Release to send'; reason = 'Release to send.'; }
  else if (!chatInCall()) { disabled = true; reason = `Waiting for ${peer} to join the call.`; }
  else if (rec || sending) { disabled = true; label = sending ? 'Sending…' : 'Hold to talk'; reason = 'Finish your other message first.'; }
  else if (playing && isContact(chat)) { disabled = true; label = 'Playing your voice'; reason = 'Wait for your cloned voice to finish.'; }
  else if (playing) { disabled = true; label = `${peer} is speaking`; reason = `Waiting for ${peer} to finish. One voice at a time.`; }
  talk.disabled = disabled;
  $('talkLabel').textContent = label;
  talk.dataset.held = rec?.kind === 'call' ? 'true' : 'false';
  talk.setAttribute('aria-label', rec?.kind === 'call' ? 'Recording. Release to send.' : disabled ? `${label}. ${reason}` : 'Hold to talk. Release to send.');
  $('hintText').textContent = reason; $('hintText').hidden = !reason;
  if (inCall && !rec && !sending) {
    if (!connected) setStatus('Reconnecting', 'processing');
    else if (playing) setStatus(`${peer} is speaking`, 'speaking');
    else if (!chatInCall()) setStatus(`Waiting for ${peer}`, 'processing');
    else if (['Reconnecting', `${peer} is speaking`, `Waiting for ${peer}`].includes(statusRaw)) setStatus('Ready');
  }

  // Voice message composer.
  const held = rec?.kind === 'message';
  record.disabled = !connected || (!!rec && !held) || sending || !chatOnline();
  record.dataset.held = held ? 'true' : 'false';
  $('recordLabel').textContent = held ? 'Release to send' : sending && !rec ? 'Polishing…' : 'Hold to record a voice message';
  // Only the circle shows, unless there's a reason it can't be used.
  $('composerHint').textContent = connected && !chatOnline() ? `${peer} is offline. Voice messages send once they sign in.` : '';
}

/* ---------- Thread ---------- */
let log = $('log');
const threads = new Map(); // conversation -> its <ol>
function threadFor(id) {
  if (!threads.has(id)) {
    const list = document.createElement('ol');
    list.className = 'log'; list.hidden = true; list.tabIndex = 0;
    list.setAttribute('role', 'log'); list.setAttribute('aria-live', 'polite');
    list.setAttribute('aria-relevant', 'additions'); list.setAttribute('aria-labelledby', 'dmTitle');
    $('log').after(list); threads.set(id, list);
  }
  return threads.get(id);
}
// Count a message that arrived in a conversation you're not looking at.
function bumpUnread(id) {
  const item = document.querySelector(`.dm-item[data-chat="${id}"]`);
  if (!item || id === chat) return;
  let badge = item.querySelector('.badge');
  if (!badge) { badge = document.createElement('span'); badge.className = 'badge'; item.append(badge); }
  const count = Number(badge.textContent || 0) + 1;
  badge.textContent = count; badge.setAttribute('aria-label', `${count} unread`);
}
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
function countEntries() {
  const count = log.children.length;
  $('logState').textContent = count ? `${count} message${count === 1 ? '' : 's'}` : 'No messages yet';
}
// One message row: avatar, name, time and kind, the words, then a status line.
function addEntry(who, text, mark, markState, kind = 'message', thread = chat) {
  const box = threadFor(thread);
  const follow = box === log && nearBottom();
  const author = who === 'you' ? me : thread;
  const li = document.createElement('li'); li.className = 'turn'; li.dataset.who = who; li.dataset.kind = kind;
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true'); setAvatar(avatar, author);
  const meta = document.createElement('p'); meta.className = 'meta';
  const label = document.createElement('span'); label.className = 'who'; label.textContent = nameOf(author);
  const time = document.createElement('time'); const at = new Date();
  time.dateTime = at.toISOString(); time.textContent = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tag = document.createElement('span'); tag.className = 'kind'; tag.dataset.kind = kind; tag.textContent = kind === 'call' ? 'In call · cloned voice' : 'Voice message';
  meta.append(label, time, tag);
  const said = document.createElement('p'); said.className = 'said'; said.textContent = text;
  const markEl = document.createElement('span'); markEl.className = 'flag';
  li.append(avatar, meta, said, markEl);
  const inGroup = kind === 'call' && callGroup && thread === chat;
  (inGroup ? callGroup.list : box).append(li);
  const entry = { li, said, markEl };
  if (inGroup) callGroup.entries.push(entry);
  setMark(entry, mark, markState);
  countEntries();
  if (follow || kind === 'call') followEntry(entry);
  return entry;
}
function setText(entry, text, pending = false) {
  if (!entry) return;
  const follow = nearBottom();
  entry.typeToken = null;
  entry.said.textContent = text; entry.said.dataset.pending = pending ? 'true' : 'false';
  if (follow) followEntry(entry);
}
function setMark(entry, text, state = '') {
  if (!entry) return;
  entry.markEl.textContent = text; entry.markEl.dataset.state = state;
}
function removeEntry(entry) { entry?.li.remove(); countEntries(); }
function followEntry(entry) { const box = entry.li.closest('.live-wrap') || entry.li.closest('.log'); if (box) box.scrollTop = box.scrollHeight; }

/* ---------- Edits view: raw words typed in live, then Sugarcoat's changes marked ---------- */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const norm = word => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
// Word-level diff of what was said against the cleaned text: [{ op: 'same' | 'del' | 'ins', word }].
// Aligned from the end, so a self-correction keeps the final wording and strikes the earlier try.
function diffWords(before, after) {
  const a = before.split(/\s+/).filter(Boolean).reverse(), b = after.split(/\s+/).filter(Boolean).reverse();
  const same = (x, y) => { const k = norm(x); return !!k && k === norm(y); };
  const n = a.length, m = b.length;
  if (n * m > 250000) return [...a.map(word => ({ op: 'del', word })), ...b.map(word => ({ op: 'ins', word }))];
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) { out.push({ op: 'same', word: b[j] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', word: a[i++] });
    else out.push({ op: 'ins', word: b[j++] });
  }
  while (i < n) out.push({ op: 'del', word: a[i++] });
  while (j < m) out.push({ op: 'ins', word: b[j++] });
  // Back in reading order; within a changed run, removed words come before added ones.
  out.reverse();
  for (let k = 1; k < out.length; k++) {
    if (out[k].op === 'del' && out[k - 1].op === 'ins') { [out[k - 1], out[k]] = [out[k], out[k - 1]]; if (k > 1) k -= 2; }
  }
  return out;
}
// Type the raw transcript in word by word, as if it were being written live.
function typeRaw(entry, raw) {
  if (!entry || !raw) return Promise.resolve();
  entry.raw = raw;
  const token = entry.typeToken = {};
  const words = raw.split(/\s+/).filter(Boolean);
  entry.said.classList.remove('animate'); entry.said.dataset.pending = 'true';
  if (reduceMotion) { entry.said.textContent = raw; return (entry.typing = Promise.resolve()); }
  const step = Math.max(25, Math.min(90, 1800 / words.length));
  const cursor = document.createElement('span'); cursor.className = 'typing';
  entry.said.replaceChildren(cursor);
  return (entry.typing = (async () => {
    for (let k = 0; k < words.length; k++) {
      if (entry.typeToken !== token) return;
      cursor.before((k ? ' ' : '') + words[k]);
      followEntry(entry);
      await sleep(step);
    }
    cursor.remove();
  })());
}
// Swap the typed transcript for the cleaned text: removed words struck in red, added words in green,
// then settle into the clean text alone. Only the speaker sees this; the other person gets clean text.
const EDIT_HOLD_MS = 1600;
async function showEdits(entry, raw, cleaned) {
  if (!entry) return;
  entry.cleaned = cleaned;
  await entry.typing;
  entry.typeToken = null;
  const parts = raw && !entry.final ? diffWords(raw, cleaned) : [];
  if (!parts.some(part => part.op !== 'same')) { setText(entry, cleaned); return; }
  const said = entry.said;
  said.replaceChildren(); said.dataset.pending = 'false'; said.classList.remove('animate');
  let k = 0;
  parts.forEach((part, index) => {
    if (index) said.append(' ');
    if (part.op === 'same') { said.append(part.word); return; }
    const el = document.createElement(part.op); el.textContent = part.word; el.style.setProperty('--i', k++);
    said.append(el);
  });
  if (!reduceMotion) { void said.offsetWidth; said.classList.add('animate'); }
  followEntry(entry);
  const token = entry.typeToken = {};
  await sleep((reduceMotion ? 0 : k * 70 + 650) + EDIT_HOLD_MS);
  if (entry.typeToken !== token) return;
  said.classList.add('settle');
  await sleep(reduceMotion ? 0 : 450);
  if (entry.typeToken !== token) return;
  setText(entry, cleaned);
}

/* ---------- The call's record in the DM: "Call started" ... "Call ended" ---------- */
let callGroup = null;
const PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>';
const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const stamp = date => date.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
function callMark(text, end = false) {
  const mark = document.createElement('p'); mark.className = end ? 'call-mark end' : 'call-mark';
  mark.innerHTML = PHONE; mark.append(text);
  return mark;
}
function startCallGroup() {
  if (callGroup) return;
  const li = document.createElement('li'); li.className = 'call-group';
  const note = document.createElement('p'); note.className = 'note'; note.textContent = 'Call in progress. Follow along in the live transcript above.';
  li.append(callMark(`Call started · ${stamp(new Date())}`), note); log.append(li);
  const list = document.createElement('ol'); list.className = 'call-list';
  $('liveWrap').replaceChildren(list);
  callGroup = { li, list, note, entries: [], startedAt: Date.now() };
  countEntries(); log.scrollTop = log.scrollHeight;
}
function endCallGroup() {
  const group = callGroup; if (!group) return;
  callGroup = null;
  const count = group.list.children.length;
  const minutes = Math.max(1, Math.round((Date.now() - group.startedAt) / 60000));
  group.note.textContent = 'No one spoke.'; group.note.hidden = count > 0;
  // The record keeps only the clean words, no edit marks.
  for (const entry of group.entries) { entry.final = true; if (entry.cleaned) setText(entry, entry.cleaned); }
  group.li.append(group.list);
  if (count > 1) {
    // Show the first message; the rest open on demand.
    const more = document.createElement('button'); more.type = 'button'; more.className = 'call-more';
    const text = document.createElement('span');
    more.append(text); more.insertAdjacentHTML('beforeend', CHEVRON);
    const label = open => { text.textContent = open ? 'Show less' : `Show ${count - 1} more message${count === 2 ? '' : 's'}`; more.setAttribute('aria-expanded', String(open)); };
    more.addEventListener('click', () => label(!group.li.classList.toggle('collapsed')));
    group.li.classList.add('collapsed'); label(false);
    group.li.append(more);
  }
  group.li.append(callMark(`Call ended · ${stamp(new Date())} · ${minutes} min · ${count} message${count === 1 ? '' : 's'}`, true));
  $('liveWrap').replaceChildren();
  log.scrollTop = log.scrollHeight;
}

/* ---------- Level meters (mic while you hold, the other voice while it plays) ---------- */
function startMeter(sourceNode, targets) {
  const analyser = ctx.createAnalyser(); analyser.fftSize = 512;
  sourceNode.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let frame = 0, alive = true;
  const set = value => { for (const el of targets) el?.style.setProperty('--level', value); };
  const tick = () => {
    if (!alive) return;
    analyser.getFloatTimeDomainData(data);
    let sum = 0; for (const v of data) sum += v * v;
    set(Math.min(1, Math.sqrt(sum / data.length) * 6).toFixed(3));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return { stop() { alive = false; cancelAnimationFrame(frame); try { sourceNode.disconnect(analyser); } catch {} set('0'); } };
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
const withToken = path => `${path}${path.includes('?') ? '&' : '?'}as=${encodeURIComponent(me)}&` +
  (viaSession ? `access_token=${encodeURIComponent(getSession()?.access_token || '')}` : `t=${encodeURIComponent(token)}`);
// Keep the account session fresh; accessToken() refreshes shortly before expiry.
setInterval(() => { if (viaSession) accessToken(); }, 30000);
const postJson = (path, body) => fetch(withToken(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function invalidLink() {
  if (viaSession) { logout(); showLogin('Your session ended. Sign in again.'); return; }
  if (accounts) { stopConnection(); location.replace('/call'); return; } // stale token link: sign in instead
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
    if (inCall && body.inVoice === false && !isContact(chat)) postJson('/api/call/voice', { in: true }).catch(() => {});
    for (const item of body.events || []) {
      if (cursor != null && item.id <= cursor) continue;
      try { handlers[item.event]?.(item.data); } catch (error) { console.error(error); }
    }
    if (Number.isFinite(body.cursor)) cursor = body.cursor;
    refresh();
  }
}

/* ---------- Saved history ---------- */
// Earlier messages with your peer, saved on the server when accounts are on. They go
// above anything that arrived while loading; ids already on screen are skipped.
async function loadHistory(peer) {
  let rows;
  try {
    const response = await fetch(withToken('/api/call/history'), { cache: 'no-store' });
    if (!response.ok) return;
    rows = (await response.json()).messages;
  } catch { return; }
  if (!Array.isArray(rows) || !rows.length || peer !== peerOf(me)) return;
  const box = threadFor(peer), first = box.firstChild;
  for (const row of rows) {
    if (!row?.id || box.querySelector(`[data-id="${CSS.escape(String(row.id))}"]`)) continue;
    const entry = addEntry(row.from === me ? 'you' : 'peer', String(row.text || ''), '', '', row.kind === 'call' ? 'call' : 'message', peer);
    entry.li.dataset.id = row.id;
    const at = new Date(row.at), time = entry.li.querySelector('time');
    if (time && !Number.isNaN(at.getTime())) {
      time.dateTime = at.toISOString();
      const sameDay = at.toDateString() === new Date().toDateString();
      time.textContent = sameDay ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    box.insertBefore(entry.li, first);
  }
  countEntries();
  if (box === log) log.scrollTop = log.scrollHeight;
}

/* ---------- Sign in / out ---------- */
function showLogin(message = '') {
  showPassword(false);
  $('app').hidden = true; $('login').hidden = false;
  $('loginError').textContent = message; $('loginError').hidden = !message;
  document.title = 'Sign in · Sugarcoat';
}
function enterApp(who) {
  me = who; signedIn = true; everOpened = false; errorsInRow = 0; connected = false;
  ssSet('vf-comms-user', me);
  const peer = peerOf(me);
  $('login').hidden = true; $('app').hidden = false;
  $('meName').textContent = NAMES[me]; setAvatar($('meAvatar'), me);
  $('peerNameRail').textContent = NAMES[peer]; setAvatar($('peerAvatar'), peer);
  $('tileMeName').textContent = `${NAMES[me]} (you)`; setAvatar($('tileMeAvatar'), me);
  $('dmPeer').dataset.chat = peer; threads.set(peer, $('log'));
  toggleAdd(false); renderPending();
  chat = ''; openChat(peer);
  setConnection('Connecting…', 'wait');
  if (!window.fetch || !window.AudioContext || !window.MediaRecorder) setLinkError('This browser can’t run calls. Use current Chrome, Safari, or Firefox.');
  else if (!window.isSecureContext) setLinkError('The microphone only works on localhost or HTTPS. Open the link you were given.');
  openStream(); refresh();
  if (accounts) loadHistory(peer);
}
async function signIn(event, create = false) {
  event?.preventDefault();
  if (accounts && !legacyLink) {
    const email = $('username').value.trim(), password = $('password').value;
    if (!email || !password) { showLogin('Enter your email and password.'); return; }
    // This click can unlock audio, so incoming voices play later.
    ctx ||= new AudioContext({ latencyHint: 'interactive' });
    ctx.resume().catch(() => {}); applySink();
    $('signIn').disabled = $('signUp').disabled = true;
    try {
      const session = await accountSignIn(email, password, { create });
      if (session.confirm) { showLogin('Check your email to confirm the account, then sign in.'); return; }
      $('password').value = '';
      if (params.get('next') === '/lite') { location.replace('/lite'); return; }
      viaSession = true; enterApp(session.handle);
    } catch (error) { showLogin(error.message); $('password').select(); }
    finally { $('signIn').disabled = $('signUp').disabled = false; }
    return;
  }
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
  if (viaSession) { viaSession = false; signOut(); }
  endCall(true);
  stopConnection(); signedIn = false; connected = false; peerOnline = false; peerInCall = false;
  cancelRecording(); releaseMic();
  for (const list of threads.values()) if (list !== $('log')) list.remove();
  threads.clear(); log = $('log'); log.hidden = false; chat = '';
  log.replaceChildren(); countEntries(); hideError(); setLinkError('');
  ctx?.close().catch(() => {}); ctx = null;
  ssSet('vf-comms-user', '');
  $('username').value = ''; showLogin();
  $('username').focus();
}

/* ---------- Connections: add by email ---------- */
// A request shows greyed out as Pending until the other person adds you back. There is no
// backend for this yet, so pending requests live in this browser, per signed-in person.
const pendingKey = () => `vf-pending-${me}`;
const readPending = () => { try { return JSON.parse(lsGet(pendingKey()) || '[]'); } catch { return []; } };
const nameFromEmail = email => email.split('@')[0].split(/[._-]+/).filter(Boolean)
  .map(word => word[0].toUpperCase() + word.slice(1)).join(' ') || email;
function renderPending() {
  for (const row of document.querySelectorAll('.dm-list .pending-row')) row.remove();
  for (const email of readPending()) {
    const name = nameFromEmail(email);
    const li = document.createElement('li'); li.className = 'pending-row';
    const row = document.createElement('div'); row.className = 'dm-item pending'; row.title = `Waiting for ${email} to add you back`;
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = name[0];
    const text = document.createElement('span'); text.className = 'dm-text';
    const label = document.createElement('span'); label.className = 'dm-name'; label.textContent = name;
    const state = document.createElement('span'); state.className = 'dm-state'; state.textContent = 'Pending';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'icon-button cancel-pending';
    cancel.setAttribute('aria-label', `Cancel request to ${email}`); cancel.title = 'Cancel request';
    cancel.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    cancel.addEventListener('click', () => { lsSet(pendingKey(), JSON.stringify(readPending().filter(item => item !== email))); renderPending(); $('addBtn').focus(); });
    text.append(label, state); row.append(avatar, text, cancel); li.append(row);
    document.querySelector('.dm-list').append(li);
  }
}
function toggleAdd(open = $('addForm').hidden) {
  $('addForm').hidden = !open; $('addBtn').setAttribute('aria-expanded', String(open)); $('addNote').textContent = '';
  if (open) $('addEmail').focus();
}
$('addBtn').addEventListener('click', () => toggleAdd());
$('addForm').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); toggleAdd(false); $('addBtn').focus(); } });
$('addForm').addEventListener('submit', event => {
  event.preventDefault();
  const email = $('addEmail').value.trim().toLowerCase(), note = text => { $('addNote').textContent = text; };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return note('Enter a full email address.');
  if (email === String(getSession()?.email || '').toLowerCase()) return note('That’s your own email.');
  if (readPending().includes(email)) return note(`${email} is already pending.`);
  lsSet(pendingKey(), JSON.stringify([...readPending(), email]));
  $('addEmail').value = ''; renderPending();
  note(`Request sent. ${nameFromEmail(email)} shows as Pending until they add you back.`);
});

/* ---------- Conversations ---------- */
const PEER_HINT = $('emptyHint').textContent;
function openChat(id) {
  if (!signedIn || id === chat) return;
  if (rec) cancelRecording();
  if (inCall) endCall(true); // one call at a time
  hideError();
  log.hidden = true; chat = id; log = threadFor(id); log.hidden = false;
  for (const item of document.querySelectorAll('.dm-item[data-chat]')) {
    if (item.dataset.chat === id) { item.setAttribute('aria-current', 'page'); item.querySelector('.badge')?.remove(); }
    else item.removeAttribute('aria-current');
  }
  const name = nameOf(id);
  document.title = `${name} · Sugarcoat`;
  $('dmTitle').textContent = name; $('tilePeerName').textContent = name;
  $('emptyTitle').textContent = `This is the start of your conversation with ${name}.`;
  $('emptyHint').textContent = isContact(id)
    ? `${name} is a test contact for checking your setup; nothing you send reaches anyone. Voice messages show Sugarcoat’s cleanup. In a call, each line plays back in your cloned voice, so you can confirm Twinly works.`
    : PEER_HINT;
  setAvatar($('emptyAvatar'), id); setAvatar($('tilePeerAvatar'), id);
  countEntries(); refresh();
}
document.querySelector('.dm-list').addEventListener('click', event => {
  const item = event.target.closest('.dm-item[data-chat]');
  if (item) { openChat(item.dataset.chat); setDrawer(false); }
});

// Phones: the sidebar slides over the conversation, which is greyed out and inert meanwhile.
const phone = matchMedia('(max-width: 759px)');
function setDrawer(open) {
  open &&= phone.matches;
  const wasOpen = $('app').dataset.drawer === 'open';
  $('app').dataset.drawer = open ? 'open' : '';
  $('scrim').hidden = !open; $('dm').inert = open;
  $('menuBtn').setAttribute('aria-expanded', String(open));
  if (open) (document.querySelector('.dm-item[aria-current="page"]') || $('rail')).focus();
  else if (wasOpen && phone.matches) $('menuBtn').focus();
}
$('menuBtn').addEventListener('click', () => setDrawer(true));
$('scrim').addEventListener('click', () => setDrawer(false));
$('rail').addEventListener('keydown', event => { if (event.key === 'Escape' && settings.hidden) setDrawer(false); });
phone.addEventListener('change', () => setDrawer(false));

/* ---------- Voice call ---------- */
async function joinCall() {
  hideError();
  ctx ||= new AudioContext({ latencyHint: 'interactive' });
  ctx.resume().catch(() => {}); applySink();
  joinBtn.disabled = true;
  if (isContact(chat)) {
    inCall = true; startCallGroup(); setStatus('Ready');
    ensureMic().catch(error => showError(error.name === 'NotSupported' ? error.message : micError(error)));
    refresh(); return;
  }
  try {
    const response = await postJson('/api/call/voice', { in: true });
    if (response.status === 401) { invalidLink(); return; }
    if (!response.ok) throw new Error();
    const body = await response.json();
    inCall = true; peerInCall = !!body.peerInVoice;
    startCallGroup();
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
  endCallGroup();
  if (wasIn && tellServer && !isContact(chat)) postJson('/api/call/voice', { in: false }).catch(() => {});
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
    recorder.onstop = () => { clearTimeout(run.maxTimer); run.meter?.stop(); if (!run.cancelled && !run.discarded) sendRecording(run, mimeType); };
    recorder.start();
    try {
      ctx ||= new AudioContext({ latencyHint: 'interactive' });
      run.meter = startMeter(ctx.createMediaStreamSource(stream), kind === 'call' ? [talk, $('meterMe')] : [record]);
    } catch { /* the meter is decoration */ }
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
  const to = chat;
  sending = true; if (isCall) setStatus('Cleaning', 'processing'); refresh();
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 120000);
  let entry = addEntry('you', '…', 'Transcribing', 'waiting', run.kind, to), cleanedText = '', finished = false;
  setText(entry, '…', true);
  try {
    const response = await fetch(withToken(`${isCall ? '/api/call/speak' : '/api/call/message'}?to=${encodeURIComponent(to)}`), { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob, signal: abort.signal });
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
        if (entry && event.transcript) typeRaw(entry, String(event.transcript));
      } else if (event.type === 'preview') { if (entry && event.text && !entry.raw) setText(entry, String(event.text), true); }
      else if (event.type === 'cleaned') {
        cleanedText = String(event.text || '').trim();
        if (cleanedText) {
          entry.id = event.id ?? null; ownEntries.set(entry.id, entry); if (entry.id) entry.li.dataset.id = entry.id;
          const early = turns.get(entry.id); if (early?.own && !early.entry) early.entry = entry;
          showEdits(entry, String(event.raw || entry.raw || ''), cleanedText); }
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
    else if (isCall && isContact(to)) { if (!entry.playedBack) setMark(entry, 'Your voice is ready', 'waiting'); setStatus('Sent', 'ready'); }
    else if (isCall) { setMark(entry, `Sent. Waiting for ${nameOf(to)}`, 'waiting'); sentPending.push(entry); setStatus('Sent', 'ready'); }
    else setMark(entry, `Delivered to ${nameOf(to)}`, 'heard');
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
const senderOf = data => { const from = String(data.from || ''); return from !== me && (NAMES[from] || isContact(from)) ? from : ''; };
function onMessage(data) {
  const from = senderOf(data); if (!from) return;
  const entry = addEntry('peer', String(data.text || ''), '', '', 'message', from);
  if (data.id) entry.li.dataset.id = data.id;
  bumpUnread(from);
}
function turnFor(id, from = chat) {
  let turn = turns.get(id);
  if (!turn) {
    turn = { id, clips: new Map(), played: 0, of: 0, last: null, done: false, failed: false, createdAt: performance.now() };
    turns.set(id, turn);
    if (inCall && from === chat) queue.push(turn); else turn.done = true;
  }
  return turn;
}
function onCaption(data) {
  const from = senderOf(data);
  if (data.id == null || !from || turns.has(data.id)) return;
  const turn = turnFor(data.id, from), live = inCall && from === chat;
  turn.entry = addEntry('peer', String(data.text || ''), live ? 'Waiting' : 'Said in the call', live ? 'waiting' : '', 'call', from);
  turn.entry.cleaned = String(data.text || ''); turn.entry.li.dataset.id = data.id;
  refresh(); pump();
}
function onClip(data) {
  const from = senderOf(data);
  if (data.id == null || !from) return;
  const turn = turnFor(data.id, from);
  // A test contact's clip is your own line in your cloned voice: play it on your message.
  // The clip can beat the "cleaned" line of your own send; sendRecording attaches the entry then.
  if (!turn.entry && isContact(from)) { turn.entry = ownEntries.get(data.id); turn.own = true; }
  if (!turn.entry && !turn.own) turn.entry = addEntry('peer', 'Voice message', 'Waiting', 'waiting', 'call', from);
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
      await playClip(clip, () => setMark(turn.entry, turn.own ? 'Playing your cloned voice' : 'Speaking', 'speaking'));
    } catch (error) {
      if (!inCall) return;
      ok = false; break;
    }
    turn.played++; turn.last = clip.seq;
  }
  if (!inCall || turn.done) return;
  if (!ok) {
    finishTurn(turn, 'Couldn’t play', 'failed');
    showError(turn.own ? 'Your cloned voice was made but couldn’t be played. Check your speaker, then try again.'
      : `${peerName()} said something, but it couldn’t be played. Ask them to say it again.`);
    return;
  }
  if (turn.own) { if (turn.entry) turn.entry.playedBack = true; finishTurn(turn, 'Played in your cloned voice', 'heard'); return; }
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
  if (viaSession) url.searchParams.set('access_token', getSession()?.access_token || '');
  else if (!url.searchParams.has('t')) url.searchParams.set('t', token);
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
      let level; try { level = startMeter(node, [$('meterPeer')]); } catch {}
      const finish = () => { clearTimeout(guard); level?.stop(); node.disconnect(); if (currentSource === node) currentSource = null; resolve(); };
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
// Eye button: show or hide the password while typing.
function showPassword(visible) {
  $('password').type = visible ? 'text' : 'password';
  const label = visible ? 'Hide password' : 'Show password';
  $('revealPassword').setAttribute('aria-pressed', String(visible));
  $('revealPassword').setAttribute('aria-label', label); $('revealPassword').title = label;
}
$('revealPassword').addEventListener('click', () => { showPassword($('password').type === 'password'); $('password').focus(); });
$('loginForm').addEventListener('submit', () => showPassword(false), true);
$('signUp').addEventListener('click', () => signIn(null, true));

// Twinly key (accounts only): saved encrypted on the server, checked with Twinly first.
function showTwinlyHint(hint) {
  $('twinlyHint').textContent = hint ? `Saved key: ${hint}` : 'No key saved. Calls use the server’s key.';
  $('twinlyRemove').hidden = !hint;
}
async function loadTwinly() {
  if (!viaSession) return;
  try { const response = await authFetch('/api/me'); if (response.ok) showTwinlyHint((await response.json()).twinly?.hint); } catch {}
}
async function saveTwinly(method, body) {
  $('twinlySave').disabled = $('twinlyRemove').disabled = true;
  $('twinlyNote').textContent = method === 'PUT' ? 'Checking the key with Twinly…' : 'Removing…';
  try {
    const response = await authFetch('/api/me/twinly', { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}.`);
    $('twinlyKey').value = ''; showTwinlyHint(data.twinly?.hint);
    $('twinlyNote').textContent = method === 'PUT' ? 'Saved. Your voice now uses this key.' : 'Removed.';
  } catch (error) { $('twinlyNote').textContent = error.message; }
  finally { $('twinlySave').disabled = $('twinlyRemove').disabled = false; }
}
$('twinlySettings').addEventListener('submit', event => {
  event.preventDefault();
  const key = $('twinlyKey').value.trim();
  if (key) saveTwinly('PUT', { key });
});
$('twinlyRemove').addEventListener('click', () => saveTwinly('DELETE'));
$('logout').addEventListener('click', logout);
joinBtn.addEventListener('click', joinCall);
leaveBtn.addEventListener('click', () => { endCall(true); setStatus('Ready'); });

// Audio settings: the gear in the corner opens microphone and speaker choices.
const settingsBtn = $('settingsBtn'), settings = $('settings');
function toggleSettings(open = settings.hidden) {
  settings.hidden = !open; settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) { listDevices(); loadTwinly(); $('micSelect').focus(); }
}
settingsBtn.addEventListener('click', () => toggleSettings());
document.addEventListener('pointerdown', event => {
  if (!settings.hidden && !settings.contains(event.target) && !settingsBtn.contains(event.target)) toggleSettings(false);
});
settings.addEventListener('keydown', event => { if (event.key === 'Escape') { toggleSettings(false); settingsBtn.focus(); } });

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
if (accounts && !legacyLink) {
  $('usernameLabel').textContent = 'Email'; $('username').type = 'email'; $('username').autocomplete = 'email';
  document.querySelector('.login-card .hint').textContent = 'Sign in with your Sugarcoat account.';
  $('signUp').hidden = false; $('twinlySettings').hidden = false;
  if (await accessToken()) {
    if (params.get('next') === '/lite') location.replace('/lite');
    else { viaSession = true; enterApp(getSession().handle); }
  } else { showLogin(); $('username').focus(); }
} else if (!token) { showLogin(INVALID_LINK); $('signIn').disabled = true; }
else if (preset) enterApp(preset);
else { showLogin(); $('username').focus(); }
listDevices();
