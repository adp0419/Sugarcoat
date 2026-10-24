// VoiceFlow frontend: vanilla JS, no build step. Shapes mirror types.ts / docs/md/10-api-contract.md.
// The page is three steps: 1 Speak (record + live draft) -> 2 Review (progress, then the text) -> 3 Hear it.
"use strict";

const $ = (id) => document.getElementById(id);
const NS = "http://www.w3.org/2000/svg";
const MAX_SECONDS = 45;
const RING = 351.86; // 2 * PI * r(56), matches .ring-fill stroke-dasharray
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");
// Backend stage names -> the four steps the user sees. Convert is part of hearing.
const STAGE_MAP = { convert: "hear", asr: "hear", decide: "analyse", rewrite: "edit", guard: "check" };
const STAGE_LABEL = { hear: "Listening to your recording", analyse: "Analysing how you spoke", edit: "Editing the words", check: "Checking the meaning" };
const STYLE_LABEL = { minimal: "Light", natural: "Natural", presenter: "Presenter" };

const params = new URLSearchParams(location.search);
const app = {
  mock: params.get("mock") === "1",
  hang: params.get("hang") === "1" ? "rewrite" : params.get("hang"), // test toggle: offline mock never finishes this stage
  health: null,
  job: null,
  jobId: null,         // id of the job being processed (app.job is only set once it is ready)
  busy: false,         // a recording was submitted and has no result yet (step 2 shows progress)
  heard: false,        // speaking started for this job (step 3 is the current step)
  blob: null,          // last recording, kept in memory only (for "Play original" and "Try again")
  recorder: null, stream: null, chunks: [], recMime: "", recStart: 0, timerId: 0, cancelled: false,
  audioCtx: null, raf: 0,
  es: null, pollId: 0, runId: 0,
  twinlyOnline: true,
  blockedJobs: new Set(), // jobs that got job_unverified: never resend (docs/md/CLAUDE.md rule 6)
  wd: null,
  modeChosen: "",      // style the user picked; new recordings use it, otherwise "auto"
  editing: false, editBefore: "",
  live: { ok: null, seq: 0, shown: 0, inflight: false, timer: 0, session: 0, text: "", said: 0, saidAt: 0 },
};

// ---------- small helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "tabindex") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const k of kids) if (k != null && k !== false) n.append(k);
  return n;
}
function icon(id, cls = "ic") {
  const s = document.createElementNS(NS, "svg"), u = document.createElementNS(NS, "use");
  s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true"); u.setAttribute("href", "#" + id);
  s.append(u);
  return s;
}
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms");
const pct = (p) => Math.round(p * 100) + "%";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtTime = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage is a convenience only */ } },
};

function setState(s) { document.body.dataset.state = s; syncSteps(); }
// Status line in step 2, announced politely for screen readers.
function setStatus(text) { $("status").textContent = text; announce(text); }
function announce(text) { $("announce").textContent = text; }

// Which step is current. Steps never hide: waiting steps show what will happen there.
function syncSteps() {
  const st = document.body.dataset.state;
  let s = ["current", "waiting", "waiting"];
  if (st === "recording") s = ["current", "waiting", "waiting"];
  else if (app.job) s = app.heard ? ["done", "done", "current"] : ["done", "current", "next"];
  else if (app.busy) s = ["done", "current", "waiting"];
  ["step-speak", "step-review", "step-hear"].forEach((id, i) => {
    const sec = $(id);
    if (sec.dataset.status !== s[i] && (s[i] === "current" || s[i] === "next")) reveal(sec);
    sec.dataset.status = s[i];
    if (s[i] === "current") sec.setAttribute("aria-current", "step"); else sec.removeAttribute("aria-current");
  });
  const hasJob = !!app.job, showProgress = app.busy && !hasJob;
  $("review-empty").hidden = hasJob || app.busy;
  $("progress").hidden = !showProgress;
  $("result").hidden = !hasJob;
  $("hear-empty").hidden = hasJob;
  $("hear-body").hidden = !hasJob;
  document.body.dataset.phase = st === "recording" ? "speak" : hasJob ? (app.heard ? "hear" : "review") : app.busy ? "process" : "speak";
}
function reveal(sec) {
  sec.classList.remove("step-body-in");
  void sec.offsetWidth; // restart the short entrance animation (0 ms under reduced motion)
  sec.classList.add("step-body-in");
}

// One error box per step, so the message appears where the user is looking.
// actions: [[label, handler, primary?]]
function showError(where, message, hint, state = "error", steps = [], actions = []) {
  const box = $("err-" + where);
  const body = el("div", {},
    el("p", { class: "callout-title", text: message }),
    hint ? el("p", { class: "callout-sub", text: hint }) : null,
    steps.length ? el("ol", {}, ...steps.map((s) => el("li", { text: s }))) : null,
    actions.length ? el("div", { class: "row" }, ...actions.map(([label, fn, primary]) => {
      const b = el("button", { type: "button", class: "btn" + (primary ? " btn-primary" : ""), text: label });
      b.addEventListener("click", fn);
      return b;
    })) : null);
  box.replaceChildren(icon("i-alert", "ic callout-ic"), body);
  box.hidden = false;
  setState(state);
  box.scrollIntoView({ block: "nearest" });
  if (where === "review") $("status").textContent = message;
}
function clearError(where) { (where ? [where] : ["speak", "review", "hear"]).forEach((w) => { $("err-" + w).hidden = true; }); }

// Uniform backend errors: {error:{code,message,hint}}. Every request has a deadline so nothing waits forever.
async function api(path, opts = {}, timeoutMs = 25000) {
  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try { res = await fetch(path, { ...opts, signal: ctl.signal }); }
  catch (e) {
    if (e && e.name === "AbortError") throw { code: "timeout", message: "The server didn't answer within " + Math.round(timeoutMs / 1000) + " seconds.", hint: "It may be busy or stuck. Try again." };
    throw { code: "network", message: "Can't reach the VoiceFlow server.", hint: "Is it running? Try `make run` and reload." };
  } finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch { /* empty or non-JSON */ }
  if (!res.ok) {
    const e = body && body.error;
    throw e || { code: "http_" + res.status, message: "The server returned an error (" + res.status + ").", hint: "Try again in a moment." };
  }
  return body;
}

// ---------- service status (header popover) ----------
// Plain words for each health value, including the ones T1 added (no_credits, auth_error).
const WHY = { no_credits: "no credits", auth_error: "API key rejected", error: "error" };
function serviceStates(h) {
  const tw = h.twinly || {};
  const ai = (v, ok, fallback) => v === "ok" ? ["ok", ok]
    : v === "off" ? ["warn", "Off: " + fallback]
    : WHY[v] ? ["warn", "Unavailable (" + WHY[v] + "): " + fallback]
    : ["unknown", "Unknown"];
  return [
    { key: "asr", name: "Speech recognition", short: "Speech", st: h.asr_loaded ? ["ok", "Ready"] : ["idle", "Loads on your first recording, so the first one is slower"] },
    { key: "gemma", name: "AI editor (Gemma 4)", short: "AI editor", st: ai(h.gemma, "Ready", "rule-based edits only") },
    { key: "decisions", name: "Analysis (OpenAI Decisions)", short: "Analysis", st: decisionsOn() ? ai(h.decisions, "Ready", "fixed meaning checks only")
      : ["idle", "Off in Settings: fixed meaning checks only"] },
    { key: "twinly", name: "Your voice (Twinly)", short: "Voice", st: tw.online && tw.voice_ready ? ["ok", "Ready"]
      : tw.online ? ["bad", "Voice clone not set up: speaking is off"] : ["bad", "Offline: you still get the text, speaking is off"] },
  ];
}
const SVC_ICON = { ok: "i-check-circle", warn: "i-alert", bad: "i-block", idle: "i-info", unknown: "i-info" };
function renderHealth(list, note, summary) {
  $("svc-list").replaceChildren(...list.map((x) => el("li", { "data-s": x.st[0] }, icon(SVC_ICON[x.st[0]]),
    el("div", {}, el("strong", { text: x.name }), el("span", { text: x.st[1] })))));
  $("status-note").textContent = note; $("status-note").hidden = !note;
  $("status-dot").dataset.s = summary[0];
  $("status-sum").textContent = summary[1];
  $("status-btn").setAttribute("aria-label", "Service status: " + summary[1] + ". Show details");
}
async function refreshHealth() {
  try {
    const h = app.mock ? { asr_loaded: true, decisions: "ok", gemma: "ok", twinly: { online: true, voice_ready: true }, mock: true } : await api("/api/health", {}, 8000);
    app.health = h;
    const list = serviceStates(h);
    const bad = list.filter((x) => x.st[0] === "bad"), warn = list.filter((x) => x.st[0] === "warn");
    const summary = bad.length ? ["bad", bad.map((x) => x.short).join(", ") + " offline"]
      : warn.length === 1 ? ["warn", warn[0].short + " limited"]
      : warn.length ? ["warn", warn.length + " services limited"] : ["ok", "All services ready"];
    if (h.mock) summary[1] += " · demo data";
    renderHealth(list, h.mock ? "Demo mode: the server returns recorded sample results, not live services." : "", summary);
    if (!$("settings").hidden) renderPipe();
    const tw = h.twinly && h.twinly.online && h.twinly.voice_ready;
    if (tw !== app.twinlyOnline || !tw) { app.twinlyOnline = !!tw; document.body.dataset.twinly = tw ? "online" : "offline"; }
  } catch {
    renderHealth([], "Can't reach the VoiceFlow server. Start it with `make run`, or tick Offline demo data at the bottom of the page.", ["bad", "Server unreachable"]);
  }
  syncSpeakButton();
}
function openPop(open) {
  $("status-pop").hidden = !open;
  $("status-btn").setAttribute("aria-expanded", String(open));
}
$("status-btn").addEventListener("click", () => openPop($("status-pop").hidden));
document.addEventListener("click", (e) => { if (!$("status-pop").hidden && !e.target.closest(".status-wrap")) openPop(false); });

// ---------- recording ----------
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}
function supportProblem() {
  if (!window.isSecureContext) return "Recording needs https or localhost. Open this page at http://localhost:8000.";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined")
    return "This browser can't record audio. Please use Chrome on desktop, or use the demo clip.";
  return "";
}

async function startRecording() {
  clearError();
  stopPlayback(); // cancel any chained playback before the mic opens
  const problem = supportProblem();
  if (problem) { showError("speak", "Recording isn't available here.", problem, "unsupported"); return; }
  try {
    app.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // first click, not on load
  } catch (e) {
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError"))
      showError("speak", "Microphone blocked.", "Click the lock icon in the address bar, allow the microphone, then press Record again.", "mic-denied");
    else if (e && e.name === "NotFoundError")
      showError("speak", "No microphone found.", "Plug one in or choose one in your system sound settings, then try again.", "mic-denied");
    else showError("speak", "Couldn't start the microphone.", (e && e.message) || "Try reloading the page.", "error");
    return;
  }
  const mime = pickMime();
  try { app.recorder = new MediaRecorder(app.stream, mime ? { mimeType: mime } : undefined); }
  catch { stopStream(); showError("speak", "This browser can't record here.", "Please use Chrome on desktop, or use the demo clip.", "unsupported"); return; }
  app.chunks = [];
  app.cancelled = false;
  app.recMime = app.recorder.mimeType || mime || "audio/webm";
  app.recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) app.chunks.push(ev.data); };
  app.recorder.onstop = () => {
    const blob = new Blob(app.chunks, { type: app.recMime });
    stopStream();
    stopLive();
    if (app.cancelled) { setState("idle"); recUi("idle"); setStatus("Recording cancelled. Nothing was sent."); resetLive(); return; }
    recUi("done", (Date.now() - app.recStart) / 1000);
    if (blob.size < 500) { showError("speak", "That recording was empty.", "Check your microphone and try again.", "error"); return; }
    submitAudio(blob);
  };
  resetResult();
  app.recorder.start(1000); // 1 s chunks: the live draft re-sends everything recorded so far
  app.recStart = Date.now();
  setState("recording");
  recUi("recording");
  announce("Recording. Press Space to stop, or Escape to cancel.");
  app.timerId = setInterval(tick, 200);
  startMeter();
  startLive();
}

// Record button, label, timer and ring for each recorder state.
function recUi(mode, seconds = 0) {
  const rec = mode === "recording";
  $("record-label").textContent = rec ? "Stop recording" : app.blob || mode === "done" ? "Record again" : "Start recording";
  $("rec-state").textContent = rec ? "Recording" : mode === "done" ? "Recorded"
    : mode === "demo" ? "Demo clip" : app.blob ? "Press to record again" : "Press to record";
  if (!rec) { $("timer").textContent = fmtTime(seconds); setRing(0); }
}
function setRing(frac) { $("ring").style.strokeDashoffset = String(RING * (1 - Math.min(1, frac))); }

function tick() {
  const s = (Date.now() - app.recStart) / 1000;
  $("timer").textContent = fmtTime(s);
  setRing(s / MAX_SECONDS);
  if (s >= MAX_SECONDS) stopRecording();
}

function stopRecording() {
  if (!app.recorder || app.recorder.state === "inactive") return;
  clearInterval(app.timerId);
  stopMeter();
  app.recorder.stop();
}
function cancelRecording() { app.cancelled = true; stopRecording(); }
function stopStream() {
  if (app.stream) app.stream.getTracks().forEach((t) => t.stop());
  app.stream = null;
}
function toggleRecord() { (document.body.dataset.state === "recording" ? stopRecording : startRecording)(); }

// ---------- live level meter ----------
// RMS of the mic signal in dB, smoothed, drawn as a short scrolling history (or one bar under reduced motion).
// ids: which meter to draw (the recorder's or stage mode's). onFrame(raw, now) gets the unsmoothed level each frame.
const METER_IDS = { wave: "wave", box: "meter", label: "meter-label" };
const meter = { an: null, buf: null, hist: [], level: 0, speaking: false, lastLoud: 0, lastAria: 0, lastPush: 0, colors: null, ids: METER_IDS, onFrame: null };
function meterColors() {
  const cs = getComputedStyle(document.documentElement);
  return { on: cs.getPropertyValue("--c-accent").trim(), off: cs.getPropertyValue("--c-line-strong").trim(), track: cs.getPropertyValue("--c-line").trim() };
}
function sizeCanvas() {
  const c = $(meter.ids.wave), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
}
function startMeter(stream = app.stream, ids = METER_IDS, onFrame = null) {
  meter.ids = ids; meter.onFrame = onFrame;
  sizeCanvas();
  meter.colors = meterColors();
  meter.hist = []; meter.level = 0; meter.speaking = false;
  try {
    app.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    meter.an = app.audioCtx.createAnalyser();
    meter.an.fftSize = 1024;
    meter.buf = new Float32Array(meter.an.fftSize);
    app.audioCtx.createMediaStreamSource(stream).connect(meter.an);
  } catch { meter.an = null; }
  const frame = (now) => {
    if (!meter.an) return;
    meter.an.getFloatTimeDomainData(meter.buf);
    let sum = 0; for (const v of meter.buf) sum += v * v;
    const db = 20 * Math.log10(Math.sqrt(sum / meter.buf.length) + 1e-8);
    const target = Math.min(1, Math.max(0, (db + 60) / 45)); // -60 dB -> 0, -15 dB -> 1
    if (meter.onFrame) meter.onFrame(target, now);
    meter.level = target > meter.level ? meter.level + (target - meter.level) * 0.6 : meter.level * 0.88; // fast attack, slow release
    if (meter.level > 0.32) meter.lastLoud = now;
    const speaking = now - meter.lastLoud < 600; // hold "speaking" briefly so pauses between words don't flicker
    if (speaking !== meter.speaking) { meter.speaking = speaking; meterLabel(speaking ? "speech" : "silence"); }
    if (now - meter.lastAria > 500) {
      meter.lastAria = now;
      $(meter.ids.box).setAttribute("aria-valuenow", String(Math.round(meter.level * 100)));
    }
    if (now - meter.lastPush > 45) { meter.lastPush = now; meter.hist.push(meter.level); if (meter.hist.length > 28) meter.hist.shift(); }
    drawMeter();
    app.raf = REDUCED.matches ? setTimeout(() => requestAnimationFrame(frame), 100) : requestAnimationFrame(frame);
  };
  meterLabel("silence");
  requestAnimationFrame(frame);
}
function drawMeter() {
  const c = $(meter.ids.wave), g = c.getContext("2d"), W = c.width, H = c.height, col = meter.colors || meterColors();
  g.clearRect(0, 0, W, H);
  if (REDUCED.matches) { // one steady level bar, no movement sideways
    g.fillStyle = col.track; g.fillRect(0, H / 2 - 4, W, 8);
    g.fillStyle = meter.speaking ? col.on : col.off; g.fillRect(0, H / 2 - 4, W * meter.level, 8);
    return;
  }
  const n = 28, gap = W / n, bw = Math.max(2, gap * 0.55);
  for (let i = 0; i < n; i++) {
    const v = meter.hist[meter.hist.length - n + i] ?? 0;
    const h = Math.max(bw, v * H);
    g.fillStyle = v > 0.32 ? col.on : col.off;
    const x = i * gap + (gap - bw) / 2, y = (H - h) / 2;
    g.beginPath(); g.roundRect ? g.roundRect(x, y, bw, h, bw / 2) : g.rect(x, y, bw, h); g.fill();
  }
}
function meterLabel(s) {
  const text = { off: "Mic off", silence: "Silence", speech: "Speaking" }[s];
  const label = $(meter.ids.label);
  label.dataset.s = s; label.textContent = text;
  $(meter.ids.box).setAttribute("aria-valuetext", s === "speech" ? "speaking" : s === "silence" ? "silence" : "microphone off");
}
function stopMeter() {
  clearTimeout(app.raf); cancelAnimationFrame(app.raf);
  meter.an = null; meter.hist = []; meter.level = 0;
  if (app.audioCtx) { app.audioCtx.close().catch(() => {}); app.audioCtx = null; }
  drawMeter();
  meterLabel("off");
  $(meter.ids.box).setAttribute("aria-valuenow", "0");
  meter.onFrame = null;
}

// ---------- live draft transcript (POST /api/live) ----------
// Every ~3 s while recording, send everything recorded so far (the webm header is in the first chunk).
// One request in flight, older seq ignored, 429 = skip this tick, 404/405 = endpoint not there: hide the box.
const LIVE_EVERY_MS = 3000;
function startLive() {
  const L = app.live;
  L.session++; L.seq = 0; L.shown = 0; L.text = ""; L.said = 0; L.saidAt = Date.now();
  if (L.ok === false) return;
  $("live").dataset.s = "listening";
  $("live-text").textContent = "Listening…";
  L.timer = setInterval(liveTick, LIVE_EVERY_MS);
}
function stopLive() { clearInterval(app.live.timer); app.live.timer = 0; }
function resetLive() {
  $("live").dataset.s = "idle";
  $("live-text").textContent = "Your words appear here as you talk.";
  app.live.text = "";
}
async function liveTick() {
  const L = app.live;
  if (L.ok === false || L.inflight || document.body.dataset.state !== "recording" || !app.chunks.length) return;
  const session = L.session, seq = ++L.seq;
  if (app.mock) return showLive(fakeLive(), seq);
  L.inflight = true;
  const fd = new FormData();
  fd.append("audio", new Blob(app.chunks, { type: app.recMime }), "live." + (app.recMime.includes("mp4") ? "m4a" : "webm"));
  fd.append("seq", String(seq));
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch("/api/live", { method: "POST", body: fd, signal: ctl.signal }).finally(() => clearTimeout(t));
    if (res.status === 404 || res.status === 405) { L.ok = false; stopLive(); $("live").hidden = true; return; }
    if (!res.ok) return; // 429 busy or a hiccup: the next tick tries again
    const body = await res.json();
    if (session !== L.session) return;
    L.ok = true;
    showLive(body.text || "", body.seq ?? seq);
  } catch { /* the draft is optional; the final transcript comes from /api/process */ }
  finally { L.inflight = false; }
}
// Offline demo (?mock=1): reveal the sample transcript at speaking pace.
function fakeLive() {
  const words = (mockVerbatim || "").split(" ");
  return words.slice(0, Math.round(((Date.now() - app.recStart) / 1000) * 2.4)).join(" ");
}
function showLive(text, seq) {
  const L = app.live;
  if (seq < L.shown || !text.trim()) return;
  L.shown = seq;
  const old = L.text.split(" ").filter(Boolean), now = text.trim().split(/\s+/);
  let same = 0; while (same < old.length && same < now.length && old[same] === now[same]) same++;
  const box = $("live-text");
  box.replaceChildren(now.slice(0, same).join(" ") + (same ? " " : ""), el("span", { class: "new", text: now.slice(same).join(" ") }));
  $("live").dataset.s = "text";
  L.text = now.join(" ");
  // Screen readers hear new words at most every 8 s, not every update.
  if (Date.now() - L.saidAt > 8000 && now.length > L.said) {
    $("live-sr").textContent = "Draft: " + now.slice(L.said).join(" ");
    L.said = now.length; L.saidAt = Date.now();
  }
}

// ---------- keyboard ----------
// Space toggles record unless the user is typing or on another control. Escape backs out of whatever is open.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("status-pop").hidden) { openPop(false); $("status-btn").focus(); return; }
    if (!$("settings").hidden) { openSettings(false); return; }
    if (app.editing) { cancelEdit(); return; }
    if (document.body.dataset.state === "recording") { e.preventDefault(); cancelRecording(); $("record").focus(); return; }
    if (app.busy && !app.job) { cancelJob(); return; }
    return;
  }
  if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.body.dataset.flow === "stage") return;
  const t = e.target;
  if (t && (t.closest("input, textarea, select, button, summary, a, audio, [tabindex]") || t.isContentEditable)) return;
  e.preventDefault();
  if ($("record").disabled) return;
  toggleRecord();
});

// ---------- demo clip ----------
// A short silent WAV: in MOCK=1 the backend returns fixture text for any audio.
function silentWav(seconds = 1.5, rate = 16000) {
  const n = Math.floor(seconds * rate), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  return new Blob([buf], { type: "audio/wav" });
}
// Length of a clip from its metadata (0 if the browser can't tell within a second).
function blobSeconds(blob) {
  return new Promise((done) => {
    const a = new Audio(), url = URL.createObjectURL(blob);
    const end = (s) => { URL.revokeObjectURL(url); done(Number.isFinite(s) ? s : 0); };
    a.preload = "metadata"; a.onloadedmetadata = () => end(a.duration); a.onerror = () => end(0);
    setTimeout(() => end(0), 1000);
    a.src = url;
  });
}
async function useDemoClip() {
  if (document.body.dataset.state === "recording") cancelRecording();
  clearError();
  resetResult();
  resetLive();
  recUi("demo");
  // demo-clip.m4a is a macOS `say` voice reading the canonical messy announcement (not a person). Falls back to silence for mock runs.
  try {
    const r = await fetch("demo-clip.m4a");
    const type = r.headers.get("content-type") || "";
    if (r.ok && type.startsWith("audio/")) { const blob = await r.blob(); recUi("demo", await blobSeconds(blob)); submitAudio(blob); return; }
  } catch { /* fall through */ }
  submitAudio(silentWav());
}

// ---------- upload + job lifecycle ----------
function resetStages() {
  document.querySelectorAll("#stages li").forEach((li) => { li.dataset.status = "idle"; });
  $("elapsed").textContent = "";
}
function resetResult() {
  closeJobStreams();
  stopWatchdog();
  app.runId++;
  app.job = null; app.jobId = null; app.busy = false; app.heard = false;
  endEdit(false);
  $("output").hidden = true;
  $("hear-body").dataset.hasAudio = "false";
  $("override").checked = false;
  $("bad").checked = false;
  $("how").open = false;
  showView("final");
  stopPlayback();
  resetStages();
  clearError();
  syncSteps();
}
function closeJobStreams() {
  if (app.es) { app.es.close(); app.es = null; }
  clearInterval(app.pollId); app.pollId = 0;
}
function cancelJob() {
  closeJobStreams(); stopWatchdog();
  app.runId++; app.busy = false; app.jobId = null;
  clearError();
  setState("idle");
  recUi("idle");
  setStatus("Cancelled. Record again when you're ready.");
  $("record").focus();
}

function currentMode() { const r = document.querySelector('input[name="mode"]:checked'); return r ? r.value : "auto"; }
function setMode(m) { const r = document.querySelector('input[name="mode"][value="' + m + '"]'); if (r) r.checked = true; }

async function submitAudio(blob) {
  closeJobStreams();
  app.runId++;
  app.job = null; app.jobId = null; app.heard = false;
  app.blob = blob;
  app.busy = true;
  $("original").disabled = false;
  clearError();
  resetStages();
  setState("uploading");
  setStatus("Uploading your recording…");
  startWatchdog();
  const run = app.runId;
  try {
    if (app.mock) return await runMock(run);
    const fd = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("wav") ? "wav" : "webm";
    fd.append("audio", blob, "recording." + ext);
    fd.append("mode", app.modeChosen || "auto");
    const terms = $("terms").value.trim();
    if (terms) fd.append("protected_terms", terms);
    if (!decisionsOn()) fd.append("decisions", "0");
    const { job_id } = await api("/api/process", { method: "POST", body: fd });
    if (run !== app.runId) return;
    app.jobId = job_id;
    noteProgress();
    watchJob(job_id);
  } catch (e) {
    if (run !== app.runId) return;
    stopWatchdog();
    showError("review", e.message || "Upload failed.", e.hint, "error", [], [["Try again", retryJob, true], ["Start over", cancelJob]]);
  }
}

// SSE first; if the stream errors, poll GET /api/jobs/{id} every 800 ms.
function watchJob(id) {
  setState("processing");
  setStatus("Working on it…");
  let finished = false;
  const done = () => { finished = true; closeJobStreams(); };
  try {
    const es = new EventSource("/api/jobs/" + encodeURIComponent(id) + "/events");
    app.es = es;
    es.addEventListener("stage", (m) => { noteProgress(); handleStage(JSON.parse(m.data)); });
    es.addEventListener("result", (m) => { done(); handleJob(JSON.parse(m.data)); });
    es.addEventListener("error", (m) => {
      if (finished) return;
      if (m && m.data) { // a real `error` event from the server
        done(); stopWatchdog();
        let body = {}; try { body = JSON.parse(m.data); } catch {}
        const e = body.error || body;
        showError("review", e.message || "The job failed.", e.hint || "Try again, or use the demo clip.", "error", [], [["Try again", retryJob, true], ["Start over", cancelJob]]);
      } else { es.close(); app.es = null; startPolling(id); } // connection problem
    });
  } catch { startPolling(id); }
}

function startPolling(id) {
  if (app.pollId) return;
  let sig = "";
  app.pollId = setInterval(async () => {
    try {
      const job = await api("/api/jobs/" + encodeURIComponent(id), {}, 5000);
      if (id !== app.jobId) return;
      // Only a change counts as progress: a stuck job answers polls with the same snapshot forever.
      const now = job.status + ":" + (job.trace || []).length;
      if (now !== sig) { sig = now; noteProgress(); }
      applyTrace(job.trace || []);
      if (job.status === "ready" || job.status === "failed") { closeJobStreams(); handleJob(job); }
    } catch (e) {
      if (e.code === "timeout" || e.code === "network") return; // the watchdog reports silence
      closeJobStreams(); stopWatchdog();
      showError("review", e.message, e.hint, "error", [], [["Try again", retryJob, true], ["Start over", cancelJob]]);
    }
  }, 800);
}

// Polling has no stage events, so derive the progress line from the job's trace.
function applyTrace(trace) {
  for (const t of trace) handleStage({ stage: t.stage, status: t.ok ? "done" : "error", ms: t.ms, preview: t.error || "" }, true);
  const last = trace.length ? trace[trace.length - 1].stage : null;
  const order = ["convert", "asr", "decide", "rewrite", "guard"];
  const next = order[order.indexOf(last) + 1];
  if (next) handleStage({ stage: next, status: "start" }, true);
}

const stageLi = (name) => document.querySelector('#stages li[data-stage="' + name + '"]');
function handleStage(ev, quiet) {
  const name = STAGE_MAP[ev.stage];
  if (!name) return;
  let status = ev.status;
  if (ev.stage === "convert" && status === "done") status = "start"; // hearing continues with speech recognition
  const li = stageLi(name);
  if (quiet && li.dataset.status === "done" && status === "start") return;
  if (li.dataset.status === status && (quiet || status === "start")) { if (status === "start") wdStage(name); return; }
  li.dataset.status = status;
  if (status === "start") wdStage(name);
  else if (app.wd && app.wd.stage === name) app.wd.stage = null;
  const words = {
    start: STAGE_LABEL[name] + "…",
    done: STAGE_LABEL[name] + ": done" + (ev.ms != null ? " in " + fmtMs(ev.ms) : "") + ".",
    error: explainFailure(ev.stage, ev.preview) + " Trying a safer fallback…",
    fallback: (ev.preview || "Using a safer fallback") + ".",
  };
  setStatus(words[status] || "");
  if (document.body.dataset.state === "uploading") setState("processing");
}

function handleJob(job) {
  stopWatchdog();
  if (job.status === "failed") {
    const e = job.error || {};
    showError("review", e.message || "We couldn't process that recording.", e.hint || "Try speaking a little closer to the microphone, or use the demo clip.", "error", [], [["Try again", retryJob, true], ["Start over", cancelJob]]);
    return;
  }
  document.querySelectorAll("#stages li").forEach((li) => { if (li.dataset.status === "idle" || li.dataset.status === "start") li.dataset.status = "done"; });
  app.job = job;
  app.busy = false;
  if (job.mode_used) setMode(job.mode_used);
  resetLive();
  store.set("vf-seen", "1");
  renderJob(job, true);
  $("h-review").focus({ preventScroll: true }); // next step: read the text first, then approve
  $("step-review").scrollIntoView({ block: "nearest" });
}

// ---------- client-side watchdog ----------
// The UI never trusts the backend to finish: it warns after 15 s of silence or when a stage runs past
// 2x its budget (docs/md/03), offers a way out, and gives up at 60 s.
const STALL_MS = 15000, HARD_STOP_MS = 60000;
const BUDGET_MS = { upload: 5000, hear: 6500, analyse: 3000, edit: 5000, check: 3000 };
const WHO = { upload: "The upload", hear: "Speech recognition", analyse: "The analysis service (OpenAI Decisions)", edit: "The AI editor (Gemma 4)", check: "The meaning check" };
const SLOW_TEXT = {
  upload: "Uploading is taking longer than usual. The server may be busy.",
  hear: "Speech recognition is taking longer than usual. The first run after the server starts can be slow while the model loads.",
  analyse: "The analysis service (OpenAI Decisions) is slow to answer.",
  edit: "The AI editor (Gemma 4) is taking longer than usual. It normally answers in under 10 seconds.",
  check: "The meaning check is slow to answer.",
};

function startWatchdog() {
  stopWatchdog();
  const now = Date.now();
  app.wd = { start: now, last: now, stage: "upload", stageStart: now, key: "", timer: setInterval(wdTick, 500) };
}
function stopWatchdog() {
  if (app.wd) clearInterval(app.wd.timer);
  app.wd = null;
  $("watch").hidden = true;
}
function noteProgress() { if (app.wd) app.wd.last = Date.now(); }
function wdStage(name) { if (app.wd && app.wd.stage !== name) { app.wd.stage = name; app.wd.stageStart = Date.now(); } }

function wdTick() {
  const wd = app.wd; if (!wd) return;
  const now = Date.now(), total = now - wd.start, quiet = now - wd.last;
  const stageMs = wd.stage ? now - wd.stageStart : 0;
  $("elapsed").textContent = Math.floor(total / 1000) + " s";
  if (total >= HARD_STOP_MS) return hardStop();
  const stalled = quiet >= STALL_MS;
  const slow = wd.stage && stageMs > 2 * BUDGET_MS[wd.stage];
  if (!stalled && !slow) { $("watch").hidden = true; wd.key = ""; return; }
  const key = (stalled ? "stall:" : "slow:") + wd.stage;
  if (key !== wd.key) { // only re-announce when the situation changes, not every tick
    wd.key = key;
    const what = SLOW_TEXT[wd.stage] || "This is taking longer than usual.";
    $("watch-msg").textContent = (stalled ? "No update from the server for " + Math.round(quiet / 1000) + " seconds. " : "") + what +
      " You can keep waiting, use your words without the AI edit, or try again.";
    $("watch").hidden = false;
    $("watch").dataset.tone = "warn";
    $("wd-plain").disabled = false;
  }
  $("watch-time").textContent = "Waiting " + Math.floor(total / 1000) + " s so far. We stop waiting at " + HARD_STOP_MS / 1000 + " s.";
}

function hardStop() {
  const stage = app.wd && app.wd.stage;
  closeJobStreams();
  stopWatchdog();
  app.runId++; // ignore anything the stuck job sends later
  const li = stage && stageLi(stage);
  if (li) li.dataset.status = "error";
  setState("error");
  $("watch").dataset.tone = "bad";
  $("watch-msg").textContent = "We stopped waiting after 60 seconds: " + (WHO[stage] || "the server") + " didn't finish. " +
    "Use your words without the AI edit, or try again.";
  $("watch-time").textContent = "";
  $("watch").hidden = false;
  $("elapsed").textContent = "";
  setStatus("Stopped after 60 seconds.");
}

// Way out #1: take the transcript we already have and only strip filler sounds, locally.
const STRIP_FILLERS = /(^|[\s,])(?:um+|uh+|erm|er|ah+|hmm+)(?=[\s,.!?]|$)[,]?/gi;
function stripFillers(text) {
  let t = text.replace(STRIP_FILLERS, "$1");
  t = t.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");           // "and and" -> "and"
  t = t.replace(/\s+([,.!?])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim();
  t = t.replace(/^[,.\s]+/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function usePlainText() {
  const run = ++app.runId;
  closeJobStreams();
  if (app.wd) clearInterval(app.wd.timer);
  $("wd-plain").disabled = true;
  $("watch-msg").textContent = "Getting the transcript we already have…";
  let snap = null;
  try {
    snap = app.mock ? await (await fetch("mock-job.json")).json()
      : app.jobId ? await api("/api/jobs/" + encodeURIComponent(app.jobId), {}, 5000) : null;
  } catch { snap = null; }
  if (run !== app.runId) return;
  if (!snap || !(snap.verbatim || "").trim()) {
    stopWatchdog();
    setState("error");
    $("watch").hidden = false;
    $("watch").dataset.tone = "bad";
    $("watch-msg").textContent = "There is no transcript yet: speech recognition didn't finish, so there is no text to use. Press Try again, or record again.";
    $("watch-time").textContent = "";
    return;
  }
  stopWatchdog();
  const text = stripFillers(snap.verbatim);
  const job = Object.assign({ decisions: null, trace: [], edits: [] }, snap, {
    id: snap.id || app.jobId, status: "ready", rung: "local", rewrite: text, guard: null,
    edits: [{ from: "um uh er ah hmm", to: "", reason: "filler" }],
  });
  ["edit", "check"].forEach((s) => { const li = stageLi(s); if (li.dataset.status !== "done") li.dataset.status = "fallback"; });
  handleJob(job);
  checkEdited(); // run the meaning check on the plain text (guard only, no AI edit)
}

// Way out #2: send the same recording again.
function retryJob() {
  if (!app.blob) { cancelJob(); return; }
  submitAudio(app.blob);
}

// ---------- offline demo pipeline (no server) ----------
let mockVerbatim = "";
fetch("mock-job.json").then((r) => r.json()).then((j) => { mockVerbatim = j.verbatim; }).catch(() => {});
async function runMock(run) {
  setState("processing");
  const base = await (await fetch("mock-job.json")).json();
  const steps = [["convert", 140], ["asr", 900], ["decide", 600], ["rewrite", 800], ["guard", 500]];
  for (const [stage, ms] of steps) {
    if (run !== app.runId) return;
    noteProgress();
    handleStage({ stage, status: "start" });
    if (app.hang === stage || app.hang === STAGE_MAP[stage]) return; // ?hang=<stage>: simulate a stuck backend
    await sleep(ms);
    if (run !== app.runId) return;
    noteProgress();
    handleStage({ stage, status: "done", ms });
  }
  base.mode_used = app.modeChosen || base.decisions.recommended_mode;
  base.protected_terms = $("terms").value.split(",").map((t) => t.trim()).filter(Boolean);
  handleJob(base);
}
function mockGuard(text) {
  const bad = /\bfriday\b/i.test(text);
  const violations = bad ? [{ rule: "self_correction", original_span: "Friday (superseded by Monday)", rewrite_span: "Friday", message: "You corrected Friday to Monday, but the text still says Friday." }] : [];
  return { pass: !bad, violations, decisions_probs: { meaning_preserved: bad ? 0.31 : 0.97, changed_number_date_or_name: bad ? 0.88 : 0.04 }, verifier: "online" };
}

// ---------- rendering: text views, diff, panels ----------
const FILLER_RE = /\b(um+|uh+|er+m?|ah+|hmm+|you know|i mean)\b/gi;
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

function renderVerbatim(text) {
  const p = $("verbatim"); p.replaceChildren();
  let last = 0;
  for (const m of text.matchAll(FILLER_RE)) {
    p.append(text.slice(last, m.index), el("span", { class: "filler", text: m[0] }));
    last = m.index + m[0].length;
  }
  p.append(text.slice(last));
}

// Word-level LCS diff -> ops [{t:"eq"|"del"|"ins", w}]
function diffWords(a, b) {
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = norm(A[i]) === norm(B[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (norm(A[i]) === norm(B[j])) { ops.push({ t: "eq", w: B[j] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: "del", w: A[i++] });
    else ops.push({ t: "ins", w: B[j++] });
  }
  while (i < n) ops.push({ t: "del", w: A[i++] });
  while (j < m) ops.push({ t: "ins", w: B[j++] });
  return ops;
}

// Backend reasons may be codes ("self_correction") or sentences; show codes in plain English.
const REASON_TEXT = {
  filler: "Removed filler words", repetition: "Removed a repeated word", self_correction: "You corrected yourself, so only the final version is kept",
  false_start: "Dropped a false start", restructure: "Reworded for clarity", incomplete: "Tidied an unfinished phrase", grammar: "Fixed grammar", hedge: "Kept your hedge",
};
function humanReason(r) {
  const key = String(r || "").trim().toLowerCase();
  if (REASON_TEXT[key]) return REASON_TEXT[key];
  return /^[a-z_]+$/.test(key) ? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : r;
}

// Pick the backend edit whose text overlaps this hunk the most.
function reasonFor(del, ins, edits, edited) {
  const words = (s) => new Set(s.split(/\s+/).map(norm).filter(Boolean));
  const D = words(del), I = words(ins);
  let best = null, score = 0;
  for (const e of edits || []) {
    const f = words(e.from || ""), t = words(e.to || "");
    let sc = 0; D.forEach((w) => { if (f.has(w)) sc++; }); I.forEach((w) => { if (t.has(w)) sc++; });
    if (sc > score) { score = sc; best = e; }
  }
  if (best) return humanReason(best.reason);
  return edited ? "Changed by you" : "Tidied by VoiceFlow";
}

function renderDiff() {
  if (!app.job) return;
  const ops = diffWords(app.job.verbatim, $("final-text").value);
  const edited = $("final-text").value.trim() !== (app.baseRewrite || app.job.rewrite || "").trim();
  const box = $("diff"); box.replaceChildren();
  let k = 0, hunks = 0;
  while (k < ops.length) {
    if (ops[k].t === "eq") { box.append(ops[k].w + " "); k++; continue; }
    const dels = [], inss = [];
    while (k < ops.length && ops[k].t !== "eq") { (ops[k].t === "del" ? dels : inss).push(ops[k].w); k++; }
    const d = dels.join(" "), n = inss.join(" ");
    const reason = reasonFor(d, n, app.job.edits, edited);
    const label = (d ? "Removed: " + d + ". " : "") + (n ? "Added: " + n + ". " : "") + "Why: " + reason;
    const h = el("span", { class: "hunk", tabindex: "0", "aria-label": label });
    if (d) h.append(el("del", { text: d }));
    if (d && n) h.append(" ");
    if (n) h.append(el("ins", { text: n }));
    h.append(el("span", { class: "chip", "aria-hidden": "true", text: reason }));
    box.append(h, " ");
    hunks++;
  }
  app.hunks = hunks;
  syncLegend();
  renderNames();
}

function showView(which) {
  const said = which === "said";
  if (said && app.editing) endEdit(true);
  $("show-final").setAttribute("aria-pressed", String(!said));
  $("show-said").setAttribute("aria-pressed", String(said));
  $("view-final").hidden = said || app.editing;
  $("view-said").hidden = !said;
  $("said-legend").hidden = !said;
  syncLegend();
}
// The removed/added key only makes sense when something changed.
function syncLegend() {
  const said = $("show-said").getAttribute("aria-pressed") === "true";
  $("legend").hidden = said || !app.hunks;
  $("no-changes").hidden = said || !!app.hunks;
}

const PRED_LABEL = {
  has_filler: "Filler words", has_repetition: "Repeated words", has_self_correction: "Self-correction",
  has_false_start: "False start", is_incomplete_thought: "Unfinished thought", contains_hedging: "Hedging (maybe, I think)",
  is_already_fluent: "Already fluent",
};
function renderDecisions(d) {
  const chips = $("chips"), bars = $("bars"); chips.replaceChildren(); bars.replaceChildren();
  if (!d) { chips.append(el("span", { class: "help", text: "No analysis for this run." })); return; }
  if (d.recommended_mode) chips.append(el("span", { class: "chip-pill", text: "Suggested style: " + (STYLE_LABEL[d.recommended_mode] || d.recommended_mode) }));
  if (d.register) chips.append(el("span", { class: "chip-pill", text: "Register: " + d.register }));
  for (const [name, p] of Object.entries(d.predicates || {})) {
    const label = PRED_LABEL[name] || name.replace(/_/g, " ");
    const fill = el("span", { class: "fill" }); fill.style.width = pct(p);
    bars.append(el("li", {},
      el("span", { text: label }),
      el("span", { class: "track", role: "img", "aria-label": label + " " + pct(p) }, fill),
      el("span", { class: "pct", text: pct(p) })));
  }
}

// Plain-English version of the guard's rules (docs/md/08). Violation.rule strings are matched loosely.
const GUARD_RULES = [
  { id: "hedge", re: /hedge/i, text: "Words like \"maybe\" and \"I think\" were kept" },
  { id: "invent", re: /invent|added|new_fact|subset|no_invention/i, text: "Nothing new was added" },
  { id: "correct", re: /correct|supersed|final/i, text: "Your corrections were respected" },
  { id: "drop", re: /drop|missing|omit/i, text: "No important detail was dropped" },
  { id: "negation", re: /negat|polarity/i, text: "Yes/no meaning is unchanged" },
  { id: "strength", re: /quantif|modal|strength/i, text: "\"All/some\" and \"will/might\" are unchanged" },
  { id: "length", re: /length/i, text: "The length is reasonable" },
];
const violationText = (r) => r.message || ((r.original_span || "") + " → " + (r.rewrite_span || ""));
function renderGuard(g) {
  const list = $("guard-rules"); list.replaceChildren();
  setCheck(g ? (g.pass ? "pass" : "block") : "pending", g);
  if (!g) { $("guard-note").textContent = ""; return; }
  const hits = new Map(); const other = [];
  for (const x of g.violations || []) {
    const rule = typeof x === "string" ? { rule: "", message: x } : x;
    const idx = /^\d+$/.test(String(rule.rule)) ? Number(rule.rule) - 1 : -1;
    const match = GUARD_RULES.find((r, i) => i === idx || r.re.test(rule.rule || ""));
    if (match) { if (!hits.has(match.id)) hits.set(match.id, []); hits.get(match.id).push(rule); } else other.push(rule);
  }
  for (const r of GUARD_RULES) {
    const f = hits.get(r.id);
    const li = el("li", { "data-ok": String(!f) }, icon(f ? "i-block" : "i-check-circle"), el("span", { text: r.text + (f ? " (failed)" : "") }));
    if (f) f.forEach((x) => li.append(el("span", { class: "why", text: violationText(x) })));
    list.append(li);
  }
  for (const x of other) list.append(el("li", { "data-ok": "false" }, icon("i-block"), el("span", { text: "Another check failed" }), el("span", { class: "why", text: violationText(x) })));
  const mp = (g.decisions_probs || {}).meaning_preserved;
  $("guard-note").textContent = g.verifier === "offline"
    ? "AI verifier offline: only the fixed checks above ran."
    : mp != null ? "AI second opinion: " + pct(mp) + " sure the meaning is preserved." : "";
}
// The one meaning-check line on the main path: passed, blocked + why, or still checking.
function setCheck(s, g, text) {
  $("check").dataset.s = s;
  const first = g && (g.violations || [])[0];
  const why = first ? violationText(typeof first === "string" ? { message: first } : first) : "this text may not mean what you said.";
  const [head, rest] = text ? [text, ""] : s === "pass" ? ["Meaning check passed.", " Same meaning as what you said."]
    : s === "block" ? ["Blocked.", " " + why] : ["Checking the meaning…", ""];
  $("check-text").replaceChildren(el("strong", { text: head }), rest);
}

// ---------- plain-English explanations ----------
const SERVICE = {
  convert: "Converting the audio", asr: "Speech recognition", decide: "The analysis service (OpenAI Decisions)",
  rewrite: "The AI editor (Gemma 4)", guard: "The meaning check", speak: "Twinly",
};
// Raw errors like "ClientError: 401 UNAUTHENTICATED" -> a short reason. Order matters: most specific first.
const ERROR_REASONS = [
  [/\b401\b|\b403\b|unauthen|unauthori|api.?key|permission|access_token|auth_error/i, "rejected our API key"],
  [/\b429\b|rate.?limit|quota|credit|resource_exhausted|insufficient/i, "is out of credits or rate-limited"],
  [/timeout|timed out|deadline|took too long|did not answer|didn't answer/i, "didn't answer in time"],
  [/not set|not configured|missing key/i, "isn't configured (no API key)"],
  [/connect|network|unreachable|dns|refused/i, "couldn't be reached"],
  [/json|valueerror|parse|sanity|malformed/i, "gave an answer we couldn't use"],
  [/\b5\d\d\b|internal|unavailable|server error|overloaded/i, "had an internal error"],
];
function errorReason(raw) {
  const hit = ERROR_REASONS.find(([re]) => re.test(raw || ""));
  return hit ? hit[1] : "reported an error";
}
function explainFailure(stage, raw) { return (SERVICE[stage] || "A step") + " " + errorReason(raw) + "."; }

// Why the ladder landed where it did, from the trace the backend already returns.
function fallbackCause(job) {
  const t = job.trace || [];
  const notes = job.notes || [];
  if (notes.some((n) => /watchdog/i.test(n))) return "The AI steps took too long and the server stopped waiting";
  const down = notes.find((n) => /^AI editor unavailable:/i.test(n));
  if (down) return "The AI editor (Gemma 4) " + errorReason(down);
  const failedEdit = t.find((x) => x.stage === "rewrite" && !x.ok && x.model !== "deterministic");
  if (failedEdit) return "The AI editor (Gemma 4) " + errorReason(failedEdit.error); // raw error stays in the trace details
  const blocked = t.find((x) => x.stage === "guard" && x.ok && /^FAIL/i.test(x.preview || ""));
  if (blocked) return "The AI's edit changed your meaning (" + blocked.preview.replace(/^FAIL:\s*/i, "").replace(/\s*\(verifier \w+\)$/, "") + ")";
  return "The AI's edit didn't pass the meaning check";
}
function rungExplanation(job) {
  const cause = fallbackCause(job);
  switch (job.rung) {
    case "retry": return cause + ", so we asked the AI editor again with stricter instructions. You are seeing that second attempt; it passed the meaning check.";
    case "minimal": return (job.notes || []).some((n) => /self-corrections fixed by rules/i.test(n))
      ? cause + ", so we used fixed rules instead: filler words and repeats were removed, and where you corrected yourself only the correction was kept. Nothing else was reworded, and no names, numbers, or dates were changed."
      : cause + ", so we only removed filler words (um, uh) and repeated words. Nothing was reworded, and no names, numbers, or dates were changed.";
    case "original": return cause + ", so nothing was changed: the text is exactly what we heard. You can still edit it yourself before approving.";
    case "local": return "You chose to skip the AI edit. We removed filler sounds (um, uh) and repeated words in your browser; nothing else was changed, so self-corrections like “Friday, no wait, Monday” stay as you said them. Edit the text if you like; the meaning check runs before you can speak it.";
    default: return "";
  }
}
function renderRung(job) {
  const text = rungExplanation(job);
  $("rung").hidden = !text;
  $("rung-text").textContent = text;
}

// Backend notes (job.notes) -> sentences a user understands. Unknown notes pass through.
const NOTE_TEXT = [
  [/verifier offline/i, "The AI second opinion was unavailable, so only the fixed meaning checks ran."],
  [/decisions api (unavailable|disabled)/i, "The analysis service (OpenAI Decisions) was unavailable, so we used Natural style and the fixed meaning checks only."],
  [/guard not available/i, "The meaning check wasn't available, so this text is NOT verified. Read it carefully before approving."],
  [/watchdog|no changes made|^AI editor unavailable|self-corrections fixed by rules/i, null], // covered by the rung box
];
function renderNotes(notes) {
  const out = [];
  for (const n of notes || []) {
    const hit = NOTE_TEXT.find(([re]) => re.test(n));
    const text = hit ? hit[1] : n.replace(/^ladder:\s*/i, "");
    if (text && !out.includes(text)) out.push(text);
  }
  $("notes").replaceChildren(...out.map((t) => el("li", { text: t })));
  $("notes").hidden = !out.length;
}

function renderTrace(trace) {
  const tb = $("trace"); tb.replaceChildren();
  for (const t of trace || []) {
    const note = el("td");
    if (t.ok) note.textContent = t.preview || "";
    else {
      note.append(explainFailure(t.stage, t.error) + " ");
      if (t.error) note.append(el("details", {}, el("summary", { text: "Technical detail" }), el("code", { text: t.error })));
    }
    tb.append(el("tr", {},
      el("td", { text: t.stage + (t.ok ? "" : " (failed)") }),
      el("td", { text: fmtMs(t.ms || 0) }),
      el("td", { text: t.model || "-" }),
      note));
  }
}

const RUNG_LABEL = { full: "full AI edit", retry: "second AI attempt", minimal: "filler removal only", original: "left unchanged", local: "filler removal in your browser" };
function renderHowSummary(job) {
  const edit = (job.trace || []).filter((t) => t.stage === "rewrite" && t.ok).pop();
  const bits = [];
  if (edit && edit.model) bits.push("Edited by " + (edit.model === "deterministic" ? "fixed rules (no AI)" : edit.model));
  if (job.mode_used) bits.push((STYLE_LABEL[job.mode_used] || job.mode_used) + " style");
  bits.push("rung: " + (RUNG_LABEL[job.rung] || job.rung));
  if (job.timings && job.timings.total_ms) bits.push(fmtMs(job.timings.total_ms) + " total");
  $("how-sum").textContent = bits.join(" · ");
}

// ---------- names check (protected terms) ----------
const plain = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
function hasPhrase(text, term) { return (" " + plain(text) + " ").includes(" " + plain(term) + " "); }
function lev(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return d[b.length];
}
// Closest run of words in `text` to `term` (e.g. "Ariane Patel" for "Aryan Patel"), or null.
function closestPhrase(text, term) {
  const words = text.split(/\s+/).filter(Boolean), want = plain(term), k = want.split(" ").length;
  let best = null, bestScore = 0;
  for (let size = Math.max(1, k - 1); size <= k + 1; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const raw = words.slice(i, i + size).join(" ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const cand = plain(raw); if (!cand) continue;
      const score = 1 - lev(cand, want) / Math.max(cand.length, want.length);
      if (score > bestScore) { bestScore = score; best = raw; }
    }
  }
  return bestScore >= 0.6 ? best : null;
}
function termsFor(job) {
  const fromJob = (job && job.protected_terms) || [];
  return fromJob.length ? fromJob : $("terms").value.split(",").map((t) => t.trim()).filter(Boolean);
}
const NAME_ICON = { ok: "i-check-circle", warn: "i-alert", none: "i-info" };
function renderNames() {
  const job = app.job, list = $("names-list"); list.replaceChildren();
  const terms = job ? termsFor(job) : [];
  $("names").hidden = !terms.length;
  const final = $("final-text").value;
  for (const term of terms) {
    const heard = hasPhrase(job.verbatim || "", term), kept = hasPhrase(final, term);
    const near = heard ? null : closestPhrase(job.verbatim || "", term);
    let s = "ok", msg;
    if (heard && kept) msg = "Heard correctly and kept.";
    else if (heard) { s = "warn"; msg = "Heard correctly, but missing from the text to be spoken. Check the edit."; }
    else if (kept) msg = near ? "Speech recognition heard “" + near + "”; the text now uses “" + term + "”." : "Not heard in the recording, but the text includes it.";
    else if (near) { s = "warn"; msg = "Speech recognition heard “" + near + "” instead."; }
    else { s = "none"; msg = "Not found in what we heard."; }
    const li = el("li", { "data-s": s }, icon(NAME_ICON[s]), el("span", {}, el("span", { class: "term", text: term }), msg));
    if (!heard && !kept && near && hasPhrase(final, near)) {
      const b = el("button", { type: "button", class: "btn", text: "Use “" + term + "”" });
      b.addEventListener("click", () => replaceInFinal(near, term));
      li.append(b);
    }
    list.append(li);
  }
}
function replaceInFinal(from, to) {
  const re = new RegExp(from.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi");
  const ta = $("final-text");
  ta.value = ta.value.replace(re, to);
  ta.dispatchEvent(new Event("input")); // re-diff and re-run the meaning check
  announce("Changed to " + to + ". Checking the meaning again.");
}

function renderJob(job, fresh) {
  renderVerbatim(job.verbatim || "");
  if (fresh) { $("final-text").value = job.rewrite || ""; app.baseRewrite = job.rewrite || ""; }
  renderDiff();
  renderDecisions(job.decisions);
  renderGuard(job.guard);
  renderTrace(job.trace);
  renderRung(job);
  renderNotes(job.notes);
  renderHowSummary(job);
  $("override").checked = false;
  const ok = !job.guard || job.guard.pass;
  $("override-wrap").hidden = ok;
  if (!["speaking", "playing"].includes(document.body.dataset.state)) setState(ok ? "ready" : "guard-failed");
  else syncSteps();
  if (app.checking) setCheck("pending", null, "Checking your edit…");
  announce(!job.guard ? "Your text is ready. Checking the meaning." : ok ? "Your text is ready and passed the meaning check. Review it, then press Speak in my voice."
    : "The meaning check blocked this text. " + $("check-text").textContent);
  syncSpeakButton();
}

// ---------- editing, re-running, simulate-bad ----------
let editTimer = 0, editSeq = 0;

function finalText() { return $("final-text").value.trim(); }

function startEdit() {
  showView("final");
  app.editing = true; app.editBefore = $("final-text").value;
  $("edit-wrap").hidden = false; $("view-final").hidden = true; $("edit-btn").hidden = true;
  $("final-text").focus();
}
function endEdit(focusBack) {
  if (!app.editing) return;
  app.editing = false;
  $("edit-wrap").hidden = true; $("view-final").hidden = false; $("edit-btn").hidden = false;
  renderDiff();
  if (focusBack) $("edit-btn").focus();
}
function cancelEdit() {
  const changed = $("final-text").value !== app.editBefore;
  $("final-text").value = app.editBefore;
  endEdit(true);
  if (changed) { clearTimeout(editTimer); checkEdited(); }
  announce("Edit cancelled.");
}

function syncSpeakButton() {
  const b = $("speak");
  const st = document.body.dataset.state;
  const speaking = st === "speaking";
  const guardOk = !!app.job && (!app.job.guard || app.job.guard.pass || $("override").checked);
  const blocked = !!app.job && app.blockedJobs.has(app.job.id);
  b.disabled = speaking || app.checking || blocked || !app.job || !finalText() || !guardOk || !app.twinlyOnline;
  $("speak-label").textContent = speaking ? "Generating your voice…" : "Speak in my voice";
  $("speak-reason").textContent = !app.job ? ""
    : speaking ? "This can take up to 20 seconds."
    : blocked ? "Locked for this recording: Twinly couldn't confirm the last request, and resending could charge twice. Record again to start fresh."
    : app.checking ? "Checking your edit first…"
    : !app.twinlyOnline ? "Your voice is offline, so speaking is off. You can still copy the text."
    : !finalText() ? "There is no text to speak."
    : !guardOk ? "The meaning check blocked this text. Fix it in step 2, or tick the box above to speak it anyway."
    : "You approve this exact text by pressing the button.";
}

function mergeJob(res, keepText) {
  const text = $("final-text").value;
  Object.assign(app.job, res);
  if (keepText) $("final-text").value = text;
}

async function checkEdited() {
  if (!app.job) return;
  const seq = ++editSeq, text = finalText();
  if (!text) { app.job.guard = { pass: false, violations: [{ rule: "length", message: "The text is empty, so there is nothing to speak." }], decisions_probs: {}, verifier: "offline" }; renderJob(app.job, false); return; }
  app.checking = true; syncSpeakButton(); setCheck("pending", null, "Checking your edit…");
  try {
    const res = app.mock ? { guard: mockGuard(text), rewrite: text } : await api("/api/rewrite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: app.job.id, edited_text: text }) });
    if (seq !== editSeq) return;
    mergeJob(res, true);
  } catch (e) {
    if (seq !== editSeq) return;
    app.job.guard = { pass: false, violations: [{ rule: "", message: "We couldn't check this edit (" + (e.message || "error") + "). Speak it only if you're sure it says what you meant." }], decisions_probs: {}, verifier: "offline" };
  } finally { if (seq === editSeq) app.checking = false; }
  renderJob(app.job, false);
}

$("final-text").addEventListener("input", () => {
  renderDiff(); syncSpeakButton();
  clearTimeout(editTimer); editTimer = setTimeout(checkEdited, 700);
});
$("final-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); endEdit(true); } });
$("edit-btn").addEventListener("click", startEdit);
$("edit-done").addEventListener("click", () => endEdit(true));
$("show-final").addEventListener("click", () => showView("final"));
$("show-said").addEventListener("click", () => showView("said"));
$("override").addEventListener("change", syncSpeakButton);

$("bad").addEventListener("change", (e) => {
  if (!app.job) { e.target.checked = false; return; }
  const base = app.baseRewrite || app.job.rewrite || "";
  $("final-text").value = e.target.checked
    ? (/\bmonday\b/i.test(base) ? base.replace(/\bmonday\b/i, "Friday") : base + " See you Friday.")
    : base;
  renderDiff(); clearTimeout(editTimer); checkEdited();
});

// Edit style: re-run the AI edit on the same transcript (POST /api/rewrite {job_id, mode}).
document.querySelectorAll('.modes input[name="mode"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) changeMode(r.value); }));
async function changeMode(next) {
  if (!app.job) return;
  app.modeChosen = next;
  if (next === app.job.mode_used) return;
  const radios = document.querySelectorAll('.modes input[name="mode"]');
  radios.forEach((r) => { r.disabled = true; });
  clearError("review"); app.checking = true; syncSpeakButton();
  setCheck("pending", null, "Re-editing in " + STYLE_LABEL[next] + " style…");
  announce("Re-editing in " + STYLE_LABEL[next] + " style.");
  try {
    let res;
    if (app.mock) { await sleep(700); res = mockMode(next); }
    else res = await api("/api/rewrite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: app.job.id, mode: next }) });
    Object.assign(app.job, res);
    app.job.mode_used = next;
    app.baseRewrite = app.job.rewrite;
    $("bad").checked = false;
    app.checking = false;
    endEdit(false);
    renderJob(app.job, true);
  } catch (e) {
    app.checking = false;
    setMode(app.job.mode_used);
    renderGuard(app.job.guard);
    showError("review", e.message || "Couldn't re-edit.", e.hint, document.body.dataset.state);
  } finally { radios.forEach((r) => { r.disabled = false; }); }
  syncSpeakButton();
}
function mockMode(mode) {
  const t = { minimal: "The team meeting is on Monday at five p m. And everyone should bring their laptops.", natural: "The team meeting is on Monday at five p m. Everyone should bring their laptops.", presenter: "Team meeting: Monday, five p m. Please bring your laptops." }[mode];
  return { rewrite: t, guard: mockGuard(t), edits: app.job.edits, mode_used: mode };
}

$("copy").addEventListener("click", async () => {
  const t = $("final-text").value;
  try { await navigator.clipboard.writeText(t); }
  catch { const ta = $("final-text"); const was = $("edit-wrap").hidden; $("edit-wrap").hidden = false; ta.select(); document.execCommand("copy"); $("edit-wrap").hidden = was; }
  $("copy-label").textContent = "Copied";
  announce("Text copied.");
  setTimeout(() => { $("copy-label").textContent = "Copy"; }, 2000);
});

// ---------- speaking + playback ----------
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
const player = $("player");
const play = { chunks: [], before: 0, total: 0, done: false };
let orig = null, playId = 0;

function stopPlayback() {
  playId++;
  player.onended = null;
  player.pause(); player.removeAttribute("src"); player.load();
  if (orig) { orig.pause(); orig = null; }
  setPlaying(false);
}

$("original").addEventListener("click", () => {
  if (!app.blob) return;
  stopPlayback();
  orig = new Audio(URL.createObjectURL(app.blob));
  orig.play().catch(() => announce("Your browser couldn't play the original recording."));
  announce("Playing your original recording.");
});

function toneWav(seconds, freq = 440, rate = 16000) {
  const n = Math.floor(seconds * rate), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / rate) * 3000 * Math.min(1, i / 800, (n - i) / 800), true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

$("speak").addEventListener("click", async () => {
  if ($("speak").disabled) return;
  if (app.editing) endEdit(false);
  // Prime the audio element inside the click so later play() calls are allowed.
  stopPlayback();
  player.src = SILENT; player.play().catch(() => {});
  clearError("hear");
  const text = finalText();
  app.heard = true;
  setState("speaking"); syncSpeakButton();
  announce("Generating your voice. This can take up to 20 seconds.");
  $("output").hidden = true;
  try {
    let res;
    if (app.mock) { await sleep(1500); res = { chunks: [{ url: toneWav(1.6, 440), seconds: 1.6, cached: false }, { url: toneWav(1.6, 554), seconds: 1.6, cached: false }], total_seconds: 3.2, ms: 1500 }; }
    else res = await api("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: app.job.id, text }) }, 120000);
    if (!res.chunks && res.speak_id) res = await pollSpeak(res.speak_id);
    showAudio(res);
  } catch (e) {
    app.heard = false;
    if (document.body.dataset.state === "speaking") setState(app.job && app.job.guard && !app.job.guard.pass ? "guard-failed" : "ready");
    showSpeakError(e);
  }
  if (document.body.dataset.state === "speaking") setState("ready");
  syncSpeakButton();
});

// Twinly failures -> what happened + exact fix steps. voice_starting arrives as code "internal" with a
// "still starting" message (backend/voice.py), so match on the message too.
const SPEAK_ERRORS = {
  voice_starting: { msg: "Your Twinly voice is still starting up.", hint: "This usually takes about a minute after Twinly opens.",
    steps: ["Keep the Twinly app open on the Mac.", "Wait about a minute.", "Press Speak in my voice again."] },
  voice_not_set_up: { msg: "Your voice clone isn't set up in Twinly yet.", hint: "Speaking needs a built voice clone.", offline: true,
    steps: ["On the Mac, open Twinly and go to the Voice screen.", "Press Build my clone and wait until it says ready.", "Reload this page, then press Speak in my voice."] },
  twinly_offline: { msg: "VoiceFlow can't reach the Twinly app.", hint: "The Mac may be asleep or Twinly's voice engine stopped.", offline: true,
    steps: ["Make sure the Mac is awake and Twinly is open and signed in.", "If it is, quit Twinly (Cmd+Q) and reopen it.", "Wait a minute. Speaking comes back when the status at the top says Voice is ready."] },
  rate_limited: { msg: "Too many voice requests in a short time.", hint: "Twinly allows about 30 requests a minute, and the demo has a spending cap.",
    steps: ["Wait one minute.", "Press Speak in my voice again.", "If it says the spend cap is reached, ask the team before trying more."] },
  job_unverified: { msg: "Twinly couldn't confirm whether it spoke this line.", hint: "Do not resend: sending again may charge twice. Speaking is locked for this recording.", lock: true,
    steps: ["Check the Twinly app on the Mac to see whether the line was generated.", "Do not press speak again for this recording.", "To try again, record again or use the demo clip (that starts a new job)."] },
  approval: { msg: "Twinly is waiting for approval on the Mac.", hint: "Twinly asks the owner to allow API requests.",
    steps: ["On the Mac, open Twinly and approve the pending request.", "Press Speak in my voice again."] },
  not_found: { msg: "The server restarted and forgot this recording.", hint: "Jobs live in memory only.",
    steps: ["Record again, or use the demo clip."] },
  timeout: { msg: "Generating your voice took too long.", hint: "Twinly may be busy or its voice engine may have stopped.",
    steps: ["Check the Twinly app is open on the Mac.", "Wait a minute, then press Speak in my voice again."] },
};
function speakErrorKind(e) {
  if (e.code === "voice_starting" || /still starting/i.test(e.message || "")) return "voice_starting";
  if (/approv/i.test(e.message || "") && /twinly/i.test(e.message || "")) return "approval";
  return SPEAK_ERRORS[e.code] ? e.code : null;
}
function showSpeakError(e) {
  const kind = speakErrorKind(e), info = SPEAK_ERRORS[kind];
  const st = document.body.dataset.state;
  if (!info) { showError("hear", e.message || "Couldn't generate audio.", e.hint || "Try again in a moment.", st); return; }
  if (info.lock && app.job) app.blockedJobs.add(app.job.id);
  if (info.offline) { app.twinlyOnline = false; document.body.dataset.twinly = "offline"; }
  const msg = kind === "rate_limited" && /spend cap/i.test(e.message || "") ? "The demo's voice spending cap is reached." : info.msg;
  showError("hear", msg, info.hint + " Your text is still here to copy.", info.offline ? "twinly-offline" : st, info.steps);
}

async function pollSpeak(id) {
  for (let i = 0; i < 75; i++) { // up to ~60 s
    await sleep(800);
    const r = await api("/api/speak/" + encodeURIComponent(id));
    if (r.chunks) return r;
    if (r.error) throw r.error;
  }
  throw { code: "internal", message: "Generating audio is taking too long.", hint: "Try again in a minute." };
}

function showAudio(res) {
  const chunks = res.chunks || [];
  $("output").hidden = false;
  $("hear-body").dataset.hasAudio = "true";
  $("out-meta").textContent = (res.total_seconds || 0).toFixed(1) + " s of audio" + (chunks.length > 1 ? " in " + chunks.length + " parts" : "") +
    (res.ms ? ", made in " + fmtMs(res.ms) : "") + (chunks.length && chunks.every((c) => c.cached) ? " (from cache)" : "");
  const dl = $("downloads"); dl.replaceChildren();
  chunks.forEach((c, i) => {
    const a = el("a", { class: "btn btn-quiet", href: c.url, download: "voiceflow-" + (i + 1) + ".m4a" }, icon("i-download"), chunks.length > 1 ? "Download part " + (i + 1) : "Download");
    dl.append(a);
  });
  const focusPlayer = document.activeElement === $("speak") || document.activeElement === document.body;
  playChain(chunks);
  if (focusPlayer) $("play-btn").focus();
}

function setPlaying(on) {
  $("play-btn").dataset.playing = String(on);
  $("play-btn").setAttribute("aria-label", on ? "Pause" : "Play");
}
function setProgress(t) {
  const f = play.total ? Math.min(1, t / play.total) : 0;
  $("bar-fill").style.width = (f * 100).toFixed(1) + "%";
  $("bar").setAttribute("aria-valuenow", String(Math.round(f * 100)));
  $("play-time").textContent = fmtTime(t);
}
function afterPlayState() { return app.job && app.job.guard && !app.job.guard.pass ? "guard-failed" : "ready"; }

function playChain(chunks) {
  const my = ++playId;
  play.chunks = chunks; play.done = false;
  play.total = chunks.reduce((s, c) => s + (c.seconds || 0), 0);
  $("play-total").textContent = fmtTime(play.total);
  setProgress(0);
  let i = 0;
  const go = () => {
    if (my !== playId) return;
    if (i >= chunks.length) {
      play.done = true; setPlaying(false); setProgress(play.total);
      $("play-state").textContent = "Finished. Replay or download it below.";
      setState(afterPlayState()); syncSpeakButton();
      return;
    }
    play.before = chunks.slice(0, i).reduce((s, c) => s + (c.seconds || 0), 0);
    player.src = chunks[i].url;
    if (chunks[i + 1]) { const warm = new Audio(); warm.preload = "auto"; warm.src = chunks[i + 1].url; } // preload next
    $("play-state").textContent = chunks.length > 1 ? "Playing part " + (i + 1) + " of " + chunks.length + "…" : "Playing…";
    setState("playing");
    setPlaying(true);
    player.play().catch(() => { setPlaying(false); $("play-state").textContent = "Press play to listen."; setState(afterPlayState()); });
    i++;
  };
  player.onended = go;
  go();
}
player.addEventListener("timeupdate", () => { if (play.chunks.length) setProgress(play.before + player.currentTime); });
$("play-btn").addEventListener("click", () => {
  if (!play.chunks.length) return;
  if (play.done) return playChain(play.chunks);
  if (player.paused) { player.play().then(() => { setPlaying(true); setState("playing"); $("play-state").textContent = "Playing…"; }).catch(() => {}); }
  else { player.pause(); setPlaying(false); setState(afterPlayState()); $("play-state").textContent = "Paused."; }
});
$("replay").addEventListener("click", () => { if (play.chunks.length) { stopPlayback(); playChain(play.chunks); } });

// ---------- settings: the pipeline ----------
// Every step is shown with what it does, where it runs and how it's doing. Only Decisions can be switched off:
// the others are what makes the result safe and in your voice.
const decisionsOn = () => store.get("vf-decisions") !== "0";
const PIPE = [
  { key: "mic", name: "Microphone", where: "In your browser", icon: "i-mic",
    does: "Records what you say: up to 45 seconds, or one sentence at a time in Stage mode. The audio goes only to this server and is deleted after transcription.",
    down: "Use the demo clip instead.", time: "Live" },
  { key: "asr", name: "CrisperWhisper", where: "On this Mac", icon: "i-wave",
    does: "Writes down exactly what you said, including every um, restart and repeat. This word-for-word text is what every later step is checked against.",
    down: "Required. The first recording after a restart is slower while the model loads (about 10 seconds).", time: "About 1.4 s per sentence" },
  { key: "decisions", name: "Decisions", where: "OpenAI API", icon: "i-branch", optional: true,
    does: "Reads how you spoke, picks the edit style (Light, Natural or Presenter), marks sentences to leave alone, and double-checks the meaning after editing.",
    off: "Natural style is used and the meaning check runs its fixed rules only (dates, times, numbers, names, negations). Saves about half a second per recording.",
    stage: "Stage mode never uses it: it costs time a live delay doesn't have.", time: "About 0.5 s" },
  { key: "gemma", name: "Gemma 4", where: "Gemini API", icon: "i-edit",
    does: "Tidies the words: removes fillers and false starts, applies your self-corrections (“Friday, sorry, Monday” becomes “Monday”) and keeps your phrasing.",
    down: "Rule-based tidying is used instead: fillers, repeats and self-corrections are still fixed.",
    stage: "Stage mode uses the rule-based tidying, because Gemma can take 15 seconds or more.", time: "A few seconds; capped at 20 s" },
  { key: "guard", name: "Meaning check", where: "On this server", icon: "i-shield",
    does: "Compares the tidied text with what you said and blocks any change to dates, times, numbers, names, negations or hedges. A blocked edit falls back to a safer version.",
    down: "Always on. With Decisions off it runs its fixed rules only.", time: "Under 50 ms (rules)" },
  { key: "approve", name: "You approve", where: "You", icon: "i-user",
    does: "Nothing is spoken until you approve the text. In Stage mode you agree up front, and sentences that fail the meaning check are held for you.",
    down: "Always on.", time: "Your call" },
  { key: "twinly", name: "Twinly", where: "Twinly app on your Mac", icon: "i-speaker",
    does: "Speaks the approved text in your own cloned voice. It renders one line at a time; in Stage mode, sentences that pile up are spoken together so it keeps up.",
    down: "You still get the text; speaking is off until Twinly is back.", time: "About 5–8 s per line" },
];
let pipeSel = "decisions";

// [tone, words] for one step, from the last /api/health.
function pipeStatus(key) {
  if (key === "decisions" && !decisionsOn()) return ["idle", "Off: you turned it off"];
  const svc = app.health ? serviceStates(app.health).find((x) => x.key === key) : null;
  if (svc) return svc.st;
  if (key === "mic") return supportProblem() ? ["bad", "Recording isn't available in this browser"] : ["ok", "Ready"];
  return ["ok", "Always on"];
}
function renderPipe() {
  $("pipe").replaceChildren(...PIPE.map((p, i) => {
    const [tone] = pipeStatus(p.key), off = p.key === "decisions" && !decisionsOn();
    const b = el("button", { type: "button", class: "pipe-node", "aria-pressed": String(p.key === pipeSel),
      "aria-label": (i + 1) + " of " + PIPE.length + ": " + p.name + ", " + pipeStatus(p.key)[1] },
      el("span", { class: "pipe-ic" }, icon(p.icon)),
      el("span", { class: "pipe-name", text: p.name }),
      el("span", { class: "pipe-where", text: p.where }),
      el("span", { class: "sdot", "data-s": tone === "idle" ? "unknown" : tone, "aria-hidden": "true" }));
    b.addEventListener("click", () => { pipeSel = p.key; renderPipe(); });
    return el("li", { class: "pipe-step", "data-off": String(off), "data-key": p.key }, b);
  }));
  renderPipeDetail();
}
function renderPipeDetail() {
  const p = PIPE.find((x) => x.key === pipeSel), [tone, words] = pipeStatus(p.key), on = decisionsOn();
  const row = (label, text) => text ? el("div", { class: "pipe-row" }, el("dt", { text: label }), el("dd", { text })) : null;
  let control = el("p", { class: "pipe-req" }, icon("i-check-circle", "ic ic-sm"), "Required: this step keeps the result accurate and in your voice.");
  if (p.optional) {
    const sw = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(on), id: "decisions-switch" },
      el("span", { class: "switch-knob", "aria-hidden": "true" }));
    sw.addEventListener("click", () => {
      store.set("vf-decisions", decisionsOn() ? "0" : "1");
      renderPipe(); refreshHealth();
      announce("Decisions " + (decisionsOn() ? "on" : "off") + ". This applies to your next recording.");
      $("decisions-switch").focus();
    });
    control = el("div", { class: "switch-row" }, el("label", { for: "decisions-switch", text: "Use Decisions" }), sw,
      el("span", { class: "switch-state", text: on ? "On" : "Off" }));
  }
  $("pipe-detail").replaceChildren(
    el("div", { class: "pipe-detail-head" }, el("span", { class: "pipe-ic" }, icon(p.icon)),
      el("div", {}, el("h3", { text: p.name }), el("p", { class: "help", text: p.where }))),
    el("p", { class: "pipe-status", "data-s": tone }, el("span", { class: "sdot", "data-s": tone === "idle" ? "unknown" : tone, "aria-hidden": "true" }), words),
    el("dl", { class: "pipe-facts" }, row("What it does", p.does), row(p.optional ? "When it's off" : "If it's down", p.optional ? p.off : p.down),
      row("Stage mode", p.stage), row("Typical time", p.time)),
    control);
}
function openSettings(open) {
  $("settings").hidden = !open;
  $("settings-btn").setAttribute("aria-pressed", String(open));
  document.body.dataset.view = open ? "settings" : "";
  if (open) { renderPipe(); $("h-settings").focus(); refreshHealth(); }
  else $("settings-btn").focus();
}

// ---------- stage mode (POST /api/stage/segment) ----------
// A radio delay. Voice activity cuts the mic into sentences while you keep talking; each one is sent the moment
// it ends. Text comes back in ~1.5 s, but a Twinly render takes ~5-8 s per line whatever its length, so
// sentences that finish while a render is running are batched into the next render: the voice keeps up with
// continuous speech instead of falling further behind. Playback is a strict FIFO in sentence order.
// Delay = end of a sentence -> its audio starts. All times are performance.now() ms.
const VAD = {
  minLevel: 0.2,        // never call anything quieter than about -51 dBFS speech
  overFloor: 0.2,       // speech = this far above the room's noise floor (~9 dB)
  floorRise: 0.04,      // noise floor creeps up this much per second (it drops at once)
  minSpeechMs: 350,     // shorter bursts (a cough, a click) are dropped
  clauseQuietMs: 500,   // cut this soon when the live draft already ends a clause
  quietMs: 800,         // otherwise cut after this much silence
  longMs: 5000,         // after this much speech, any 300 ms breath ends the segment
  breathMs: 300,
  maxSegMs: 15000,      // hard cap
  idleMs: 8000,         // restart the recorder after this much silence so segments don't carry it
  echoHoldMs: 350,      // half-duplex: stay deaf this long after our voice stops (room echo)
};
const STAGE_LIVE_MS = 1500;
const SEG_POLL_MS = 300;
const SEG_FINAL = new Set(["done", "skipped", "failed"]);
const SEG_LABEL = { processing: "Processing", waiting: "Waiting for voice", rendering: "Making your voice", ready: "Ready",
  speaking: "Speaking now", done: "Spoken", held: "Needs review", skipped: "Skipped", failed: "Not spoken" };
const HEADPHONES = /airpods|headphone|headset|earbud|buds|beats|bose|sony wh|wf-/i;
const MOCK_STAGE = [
  ["So, um, the team meeting is on Monday at 5 PM.", "So the team meeting is on Monday at 5 PM."],
  ["Uh, everyone should, um, bring their laptops.", "Everyone should bring their laptops."],
  ["The demo is on Friday, actually, sorry, Saturday at noon.", "The demo is on Saturday at noon."],
  ["And, uh, lunch is on me.", "And lunch is on me."],
];
const stage = {
  on: false, stopping: false, session: "", n: 0, duplex: false,
  stream: null, rec: null, chunks: [], mime: "", segStart: 0,
  inSpeech: false, speechStart: 0, lastVoice: 0, muted: false, holdUntil: 0, floor: 1, lastFrame: 0,
  segs: [], groups: [], playing: null, inflight: 0, voicing: null,
  live: { timer: 0, inflight: false, text: "", gen: 0, seq: 0 },
};
window.vfStage = stage; // inspection from the console / benchmarks
const stagePlayer = new Audio();
stagePlayer.preload = "auto";
const now = () => performance.now();
const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : 0; };
const p90 = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)] : 0; };
const secs = (ms) => (ms / 1000).toFixed(1) + " s";

function setFlow(flow) {
  const st = flow === "stage";
  $("stage").hidden = !st;
  $("steps").hidden = st;
  document.body.dataset.flow = flow;
  store.set("vf-flow", flow);
  if (st && document.body.dataset.state === "recording") cancelRecording();
  if (st) listDevices();
}
function syncStageStart() {
  const ok = $("stage-consent").checked;
  $("stage-start").disabled = !ok || stage.on;
  $("stage-start-help").textContent = ok ? "Talk normally. Your voice follows a few seconds behind. Press Stop when you're done." : "Tick the first box to start.";
}
function setStageState(text) { $("stage-state").textContent = text; }
function stageError(msg, hint) {
  const box = $("err-stage");
  box.replaceChildren(icon("i-alert", "ic callout-ic"), el("div", {}, el("p", { class: "callout-title", text: msg }),
    hint ? el("p", { class: "callout-sub", text: hint }) : null));
  box.hidden = false;
}

// ---- input / output devices ----
// Input: getUserMedia deviceId. Output: HTMLMediaElement.setSinkId (Chrome, Edge, Firefox; Safari plays through
// the system output). Device names stay hidden until the page has had microphone permission once.
const CAN_SINK = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
async function listDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch { return; }
  const fill = (sel, kind, key, noun) => {
    const want = sel.value || store.get(key) || "";
    const list = devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
    sel.replaceChildren(el("option", { value: "", text: "System default " + noun }),
      ...list.map((d, i) => el("option", { value: d.deviceId, text: d.label || noun[0].toUpperCase() + noun.slice(1) + " " + (i + 1) })));
    sel.value = list.some((d) => d.deviceId === want) ? want : "";
    return list;
  };
  const ins = fill($("stage-in"), "audioinput", "vf-in", "microphone");
  fill($("stage-out"), "audiooutput", "vf-out", "speaker");
  $("stage-out-wrap").hidden = !CAN_SINK;
  $("stage-out-note").hidden = CAN_SINK;
  // Without mic permission the browser lists no named devices (often none at all): offer to ask.
  $("stage-devices").hidden = ins.some((d) => d.label);
}
async function revealDevices() {
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); }
  catch { stageError("Microphone blocked.", "Allow the microphone for this page to choose a device."); return; }
  await listDevices();
}
function outputChanged() {
  const sel = $("stage-out"), label = sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : "";
  store.set("vf-out", sel.value);
  if (HEADPHONES.test(label)) { $("stage-duplex").checked = true; store.set("vf-duplex", "1"); }
}
async function routeOutput() {
  const id = $("stage-out").value;
  if (!CAN_SINK) return;
  try { await stagePlayer.setSinkId(id); }
  catch { stageError("Couldn't use that speaker.", "Pick another output, or the system default."); }
}

async function startStage() {
  if (stage.on) return;
  $("err-stage").hidden = true; $("stage-summary").hidden = true;
  const problem = supportProblem();
  if (problem) { stageError("Recording isn't available here.", problem); return; }
  // Prime playback inside the click so later play() calls aren't blocked by autoplay rules.
  stagePlayer.src = SILENT; stagePlayer.play().catch(() => {});
  const inId = $("stage-in").value;
  try {
    stage.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: inId ? { exact: inId } : undefined,
      echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    stageError(denied ? "Microphone blocked." : e && e.name === "OverconstrainedError" ? "That microphone isn't available." : "Couldn't start the microphone.",
      denied ? "Click the lock icon in the address bar, allow the microphone, then press Start again."
        : e && e.name === "OverconstrainedError" ? "Pick another microphone, or the system default." : (e && e.message) || "Try reloading the page.");
    return;
  }
  store.set("vf-in", inId);
  await routeOutput();
  listDevices(); // names appear now that permission is granted
  stopPlayback();
  Object.assign(stage, { on: true, stopping: false, session: "st" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    n: 0, duplex: $("stage-duplex").checked, segs: [], groups: [], playing: null, voicing: null, inflight: 0, inSpeech: false,
    muted: false, holdUntil: 0, floor: 1, lastFrame: 0, mime: pickMime() || "" });
  $("stage-feed").replaceChildren(); $("h-feed").hidden = true;
  $("stage-setup").hidden = true; $("stage-run").hidden = false;
  $("stage-stop-label").textContent = "Stop";
  const track = stage.stream.getAudioTracks()[0];
  $("stage-route").textContent = (track && track.label ? track.label : "Default microphone") + " → " +
    ($("stage-out").selectedOptions[0] && $("stage-out").value ? $("stage-out").selectedOptions[0].textContent : "default speaker");
  document.querySelectorAll('input[name="flow"]').forEach((r) => { r.disabled = true; });
  updateDelay();
  startSegRecorder();
  startMeter(stage.stream, { wave: "stage-wave", box: "stage-meter", label: "stage-meter-label" }, stageFrame);
  stage.live.timer = setInterval(stageLiveTick, STAGE_LIVE_MS);
  setStageState("Listening");
  announce("Stage mode on. Talk normally; your voice follows a few seconds behind.");
  $("stage-stop").focus();
}

// One MediaRecorder per segment. The next one starts before the old one stops, so no audio falls in between.
function startSegRecorder() {
  let rec;
  try { rec = new MediaRecorder(stage.stream, stage.mime ? { mimeType: stage.mime } : undefined); }
  catch { stageError("This browser can't record here.", "Please use Chrome on desktop."); hardStopStage(); return null; }
  const chunks = [];
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  rec.start(250);
  stage.mime = rec.mimeType || stage.mime || "audio/webm";
  const old = stage.rec;
  stage.rec = rec; stage.chunks = chunks; stage.segStart = now();
  stage.live.text = ""; stage.live.gen++;
  $("stage-live").textContent = "";
  return old;
}
// Close the current segment: onBlob gets its audio (or nothing is sent when onBlob is null).
function rotateRecorder(onBlob) {
  const chunks = stage.chunks, mime = stage.mime;
  const old = stage.stopping ? stage.rec : startSegRecorder();
  if (stage.stopping) stage.rec = null;
  if (!old || old.state === "inactive") return;
  old.onstop = () => { if (onBlob) onBlob(new Blob(chunks, { type: mime })); };
  old.stop();
}

// Voice activity, every meter frame. Speech is judged against the room's own noise floor (it drops at once and
// creeps up slowly), so a fan, auto-gain or a noisy mic can't hold the gate open.
function stageFrame(level, t) {
  if (!stage.on || stage.stopping) return;
  const dt = stage.lastFrame ? Math.min(0.5, (t - stage.lastFrame) / 1000) : 0;
  stage.lastFrame = t;
  stage.floor = level < stage.floor ? level : stage.floor + VAD.floorRise * dt;
  const deaf = (!stage.duplex && !!stage.playing) || t < stage.holdUntil;
  if (deaf) { stage.muted = true; return; }
  if (stage.muted) { stage.muted = false; stage.inSpeech = false; rotateRecorder(null); setStageState("Listening"); return; } // drop the echo
  if (level > Math.max(VAD.minLevel, stage.floor + VAD.overFloor)) {
    if (!stage.inSpeech) { stage.inSpeech = true; stage.speechStart = t; setStageState("Hearing you"); }
    stage.lastVoice = t;
  }
  if (stage.inSpeech) {
    const quiet = t - stage.lastVoice, spoke = t - stage.speechStart;
    const clause = /[.?!,;:]$/.test(stage.live.text.trim());
    // Half-duplex can't play while you talk, so when your voice is waiting, the first short pause ends the segment.
    const waiting = !stage.duplex && playable();
    const need = spoke > VAD.longMs || waiting ? VAD.breathMs : clause ? VAD.clauseQuietMs : VAD.quietMs;
    if (quiet >= need || spoke >= VAD.maxSegMs) cutSegment(t);
  } else if (t - stage.segStart > VAD.idleMs) rotateRecorder(null);
}

function cutSegment(t) {
  stage.inSpeech = false;
  const end = stage.lastVoice, spoke = end - stage.speechStart;
  if (spoke < VAD.minSpeechMs) { rotateRecorder(null); setStageState("Listening"); pumpStage(); return; }
  const seg = { n: stage.n++, endAt: end, cutAt: t, state: "processing", draft: stage.live.text };
  stage.segs.push(seg);
  addSegRow(seg);
  setStageState("Listening");
  rotateRecorder((blob) => sendSegment(seg, blob));
  pumpStage(); // half-duplex playback waits for a pause; this is one
}

// Text only (consent=0): the voice is requested by voiceNext() so waiting sentences can share one render.
async function sendSegment(seg, blob) {
  stage.inflight++;
  const fd = new FormData();
  fd.append("audio", blob, "segment." + (stage.mime.includes("mp4") ? "m4a" : "webm"));
  fd.append("session", stage.session);
  fd.append("segment", String(seg.n));
  fd.append("protected_terms", $("terms").value);
  fd.append("consent", "0");
  try {
    const r = app.mock ? await mockSegment(seg) : await api("/api/stage/segment", { method: "POST", body: fd }, 30000);
    seg.respAt = now(); seg.res = r; seg.heard = r.verbatim; seg.text = r.rewrite; seg.jobId = r.job_id;
    if (r.guard && r.guard.pass) seg.state = "waiting";
    else {
      seg.state = "held";
      seg.reason = (r.guard && r.guard.violations || []).map((v) => v.message).join(" ") || "The meaning check couldn't confirm this sentence.";
      announce("A sentence needs your review before it's spoken.");
    }
  } catch (e) {
    if (e.code === "no_speech") { seg.state = "skipped"; seg.quiet = true; }
    else { seg.state = "failed"; seg.reason = e.message || "Couldn't process this sentence."; }
  } finally { stage.inflight--; }
  renderSeg(seg);
  voiceNext();
  pumpStage();
}

// One render at a time (Twinly runs one job at a time anyway). When it's free, every sentence waiting in order
// goes into the next render. A sentence still being transcribed holds back the ones after it (order matters).
async function voiceNext() {
  if (stage.voicing) return;
  const batch = [];
  for (const s of stage.segs) {
    if (s.state === "processing") break;
    if (s.state === "waiting") batch.push(s);
  }
  if (!batch.length) { maybeFinishStage(); return; }
  const g = { segs: batch, chunks: [], played: 0, speakDone: false, sentAt: now() };
  stage.voicing = g; stage.groups.push(g);
  batch.forEach((s) => { s.state = "rendering"; s.group = g; renderSeg(s); });
  const text = batch.map((s) => s.text).join(" ");
  try {
    const r = app.mock ? { speak_id: "mock" } : await api("/api/speak/async", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: batch[0].jobId, text }) });
    await pollGroup(g, r.speak_id);
  } catch (e) { failGroup(g, e); }
  if (stage.voicing === g) stage.voicing = null;
  pumpStage();
  voiceNext();
}

async function pollGroup(g, id) {
  for (let i = 0; i < 300 && stage.groups.includes(g); i++) { // ~90 s
    let r;
    try { r = app.mock ? mockSpeak(g) : await api("/api/speak/" + encodeURIComponent(id), {}, 10000); }
    catch (e) { if (e.code === "not_found") throw e; await sleep(SEG_POLL_MS); continue; }
    if (r.chunks && r.chunks.length > g.chunks.length) {
      g.chunks = r.chunks;
      if (!g.firstAt) { g.firstAt = now(); stage.voicing = null; voiceNext(); } // chunk 1 is in: line up the next render
      g.segs.forEach((s) => { if (s.state === "rendering") { s.state = "ready"; renderSeg(s); } });
      pumpStage();
    }
    if (r.status === "done" || r.status === "failed") {
      g.speakDone = true;
      if (r.status === "failed" && !g.chunks.length) throw r.error || { message: "Twinly couldn't make this audio." };
      pumpStage();
      return;
    }
    await sleep(SEG_POLL_MS);
  }
  if (!g.speakDone) throw { code: "timeout", message: "Making your voice took too long." };
}
function failGroup(g, e) {
  const kind = speakErrorKind(e || {});
  const msg = (SPEAK_ERRORS[kind] && SPEAK_ERRORS[kind].msg) || (e && e.message) || "Twinly couldn't make this sentence.";
  g.speakDone = true; g.failed = true;
  g.segs.forEach((s) => { s.state = "failed"; s.reason = msg; if (kind === "job_unverified") s.locked = true; renderSeg(s); }); // never resend
}

// Play the earliest unplayed render when its audio is there.
const nextGroup = () => stage.groups.find((g) => !g.failed && !(g.speakDone && g.played >= g.chunks.length));
function playable() { const g = !stage.playing && nextGroup(); return !!g && g.played < g.chunks.length; }
function pumpStage() {
  if (stage.playing) return;
  const g = nextGroup();
  if (!g) { maybeFinishStage(); return; }
  if (g.played >= g.chunks.length) return; // still rendering
  if (!stage.duplex && stage.inSpeech && !stage.stopping) return; // don't talk over the user; the next cut retries
  playGroup(g);
}

function playGroup(g) {
  stage.playing = g;
  g.segs.forEach((s) => { s.state = "speaking"; renderSeg(s); });
  const next = () => {
    if (stage.playing !== g) return;
    stage.playing = null;
    g.played++;
    const finished = g.speakDone && g.played >= g.chunks.length;
    g.segs.forEach((s) => { if (s.state === "speaking") s.state = finished ? "done" : "ready"; renderSeg(s); });
    if (!stage.duplex) stage.holdUntil = now() + VAD.echoHoldMs;
    updateDelay();
    if (stage.on && !stage.stopping) setStageState("Listening");
    pumpStage();
  };
  stagePlayer.onplaying = () => {
    if (g.played === 0 && !g.playAt) { g.playAt = now(); g.segs.forEach(renderSeg); updateDelay(); }
  };
  stagePlayer.onended = next;
  stagePlayer.onerror = () => { g.segs.forEach((s) => { s.reason = "The browser couldn't play this audio."; }); next(); };
  stagePlayer.src = g.chunks[g.played].url;
  setStageState(stage.duplex ? "Speaking in your voice. Keep going." : "Speaking in your voice. Pause until it ends.");
  stagePlayer.play().catch(() => { g.segs.forEach((s) => { s.reason = "The browser blocked playback. Press Start again."; }); next(); });
}

// Delay of one sentence and where it went: your pause, text, waiting for Twinly, Twinly, waiting to play.
function segDelay(s) {
  const g = s.group;
  if (!g || !g.playAt || s.manual) return null;
  return { total: g.playAt - s.endAt, cut: s.cutAt - s.endAt, text: s.respAt - s.cutAt, queue: Math.max(0, g.sentAt - s.respAt),
    voice: (g.firstAt || g.playAt) - g.sentAt, wait: Math.max(0, g.playAt - (g.firstAt || g.playAt)) };
}
function updateDelay() {
  const d = stage.segs.map(segDelay).filter(Boolean).map((x) => x.total);
  $("stage-delay").textContent = d.length ? "~" + secs(median(d)) + " behind you" : "–";
}

function segActions(seg) {
  if (seg.state !== "held") return null;
  const speakIt = el("button", { type: "button", class: "btn btn-primary", text: "Speak anyway" });
  speakIt.addEventListener("click", () => approveSeg(seg, seg.text));
  const edit = el("button", { type: "button", class: "btn", text: "Edit" });
  edit.addEventListener("click", () => editSeg(seg));
  const skip = el("button", { type: "button", class: "btn btn-quiet", text: "Skip" });
  skip.addEventListener("click", () => { seg.state = "skipped"; renderSeg(seg); voiceNext(); });
  return el("div", { class: "row" }, speakIt, edit, skip);
}
function editSeg(seg) {
  const li = seg.li, box = el("textarea", { rows: 2, value: seg.text || seg.heard || "", "aria-label": "Sentence " + (seg.n + 1) + " text" });
  const save = el("button", { type: "button", class: "btn btn-primary", text: "Speak this" });
  const cancel = el("button", { type: "button", class: "btn btn-quiet", text: "Cancel" });
  save.addEventListener("click", () => { const t = box.value.trim(); if (t) approveSeg(seg, t); });
  cancel.addEventListener("click", () => renderSeg(seg));
  li.querySelector(".seg-actions").replaceChildren(box, el("div", { class: "row" }, save, cancel));
  box.focus();
}
// Held sentence approved by hand: it joins the next render. Its delay no longer measures the pipeline.
function approveSeg(seg, text) {
  seg.text = text; seg.manual = true; seg.state = "waiting"; seg.reason = "";
  renderSeg(seg);
  voiceNext();
}

function addSegRow(seg) {
  seg.li = el("li", { class: "seg-row" });
  $("h-feed").hidden = false;
  $("stage-feed").append(seg.li);
  renderSeg(seg);
}
function renderSeg(seg) {
  const li = seg.li;
  if (!li) return;
  if (seg.quiet) { li.remove(); return; } // nothing was said: no row
  if (li.contains(document.activeElement) && li.querySelector("textarea")) return; // don't wipe an edit in progress
  li.dataset.state = seg.state;
  const d = segDelay(seg), shared = seg.group && seg.group.segs.length > 1;
  const body = el("div", { class: "seg-body" },
    el("p", { class: "seg-text", text: seg.text || seg.draft || "…" }),
    seg.heard && seg.heard !== seg.text ? el("p", { class: "seg-heard", text: "Heard: " + seg.heard }) : null,
    seg.reason ? el("p", { class: "seg-reason", text: seg.reason }) : null,
    el("div", { class: "seg-actions" }, segActions(seg)));
  const side = el("div", { class: "seg-side" },
    el("span", { class: "seg-chip", text: SEG_LABEL[seg.state] || seg.state }),
    d ? el("span", { class: "seg-delay", text: secs(d.total) + " behind",
      title: "Pause " + secs(d.cut) + " · text " + secs(d.text) + " · waiting for Twinly " + secs(d.queue) + " · Twinly " + secs(d.voice) +
        " · waiting to play " + secs(d.wait) + (shared ? " · spoken together with " + (seg.group.segs.length - 1) + " other" : "") }) : null);
  li.replaceChildren(el("span", { class: "seg-num", text: String(seg.n + 1) }), body, side);
}

// Live draft of the sentence being spoken (only this segment's audio, so each pass stays short).
async function stageLiveTick() {
  const L = stage.live;
  if (!stage.on || stage.stopping || app.mock || app.live.ok === false || L.inflight || !stage.inSpeech || stage.inflight || !stage.chunks.length) return;
  const gen = L.gen, seq = ++L.seq;
  L.inflight = true;
  const fd = new FormData();
  fd.append("audio", new Blob(stage.chunks, { type: stage.mime }), "live." + (stage.mime.includes("mp4") ? "m4a" : "webm"));
  fd.append("seq", String(seq));
  try {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch("/api/live", { method: "POST", body: fd, signal: ctl.signal }).finally(() => clearTimeout(t));
    if (!res.ok || gen !== L.gen) return;
    const body = await res.json();
    if (gen !== L.gen) return;
    L.text = body.text || "";
    $("stage-live").textContent = L.text;
  } catch { /* the draft is optional */ }
  finally { L.inflight = false; }
}

function stopStage() {
  if (!stage.on) return;
  if (stage.stopping) { hardStopStage(); return; } // second press: stop now
  if (stage.inSpeech) cutSegment(now());
  stage.stopping = true;
  clearInterval(stage.live.timer);
  rotateRecorder(null);
  stopMeter();
  if (stage.stream) stage.stream.getTracks().forEach((t) => t.stop());
  stage.stream = null;
  $("stage-live").textContent = "";
  $("stage-stop-label").textContent = "Stop now";
  setStageState("Finishing the last sentences…");
  pumpStage();
}
function hardStopStage() {
  stage.stopping = true;
  clearInterval(stage.live.timer);
  if (stage.rec && stage.rec.state !== "inactive") { stage.rec.onstop = null; stage.rec.stop(); }
  stage.rec = null;
  stopMeter();
  if (stage.stream) stage.stream.getTracks().forEach((t) => t.stop());
  stage.stream = null;
  stagePlayer.onended = null; stagePlayer.pause();
  stage.playing = null; stage.groups = []; stage.voicing = null;
  stage.segs.forEach((s) => { if (!SEG_FINAL.has(s.state) && s.state !== "held") { s.state = "skipped"; renderSeg(s); } });
  finishStage();
}
function maybeFinishStage() {
  if (stage.on && stage.stopping && !stage.inflight && !stage.playing && !stage.voicing && !nextGroup() &&
      stage.segs.every((s) => SEG_FINAL.has(s.state) || s.state === "held")) finishStage();
}
function finishStage() {
  if (!stage.on) return;
  stage.on = false;
  $("stage-run").hidden = true; $("stage-setup").hidden = false;
  document.querySelectorAll('input[name="flow"]').forEach((r) => { r.disabled = false; });
  syncStageStart();
  const ds = stage.segs.map(segDelay).filter(Boolean), spoken = stage.segs.filter((s) => s.state === "done").length;
  const renders = stage.groups.filter((g) => g.playAt).length;
  const part = (k) => secs(median(ds.map((d) => d[k])));
  const box = $("stage-summary");
  box.replaceChildren(icon("i-info", "ic callout-ic"), el("div", {},
    el("p", { class: "callout-title", text: spoken + " sentence" + (spoken === 1 ? "" : "s") + " spoken in " + renders + " voice render" + (renders === 1 ? "" : "s") +
      (ds.length ? ". Median delay " + secs(median(ds.map((d) => d.total))) + ", slowest 10% " + secs(p90(ds.map((d) => d.total))) + "." : ".") }),
    ds.length ? el("p", { class: "callout-sub", text: "Typical split: your pause " + part("cut") + ", text " + part("text") + ", waiting for Twinly " + part("queue") +
      ", Twinly " + part("voice") + ", waiting to play " + part("wait") + "." }) : null));
  box.hidden = false;
  if (ds.length) console.table(stage.segs.map((s) => ({ n: s.n + 1, state: s.state, ...Object.fromEntries(Object.entries(segDelay(s) || {}).map(([k, v]) => [k, Math.round(v)])), server: s.res && s.res.timings && s.res.timings.total_ms })));
  announce(box.textContent);
  $("stage-start").focus();
}

// Offline demo (?mock=1): canned sentences and tones, same shapes as the server.
async function mockSegment(seg) {
  await sleep(450);
  const [heard, text] = MOCK_STAGE[seg.n % MOCK_STAGE.length];
  return { job_id: "mock-" + seg.n, segment: seg.n, verbatim: heard, rewrite: text, guard: { pass: true, violations: [] },
    speak_id: null, held: false, timings: { asr_ms: 300, rewrite_ms: 1, guard_ms: 2, total_ms: 400 } };
}
const MOCK_VOICE_MS = Number(params.get("voice_ms")) || 900; // test toggle: ?voice_ms=6000 ~ a real Twinly render
function mockSpeak(g) {
  g.mockT = g.mockT || now();
  return now() - g.mockT < MOCK_VOICE_MS ? { status: "rendering", chunks: [] }
    : { status: "done", chunks: [{ url: toneWav(1.4, 440 + (g.segs[0].n % 4) * 60), seconds: 1.4, cached: false }] };
}

// ---- wiring ----
$("record").addEventListener("click", toggleRecord);
document.querySelectorAll('input[name="flow"]').forEach((r) => r.addEventListener("change", (e) => setFlow(e.target.value)));
$("stage-consent").addEventListener("change", syncStageStart);
$("stage-duplex").checked = store.get("vf-duplex") === "1";
$("stage-duplex").addEventListener("change", (e) => store.set("vf-duplex", e.target.checked ? "1" : "0"));
$("stage-start").addEventListener("click", startStage);
$("settings-btn").addEventListener("click", () => openSettings($("settings").hidden));
$("settings-back").addEventListener("click", () => openSettings(false));
$("stage-in").addEventListener("change", (e) => store.set("vf-in", e.target.value));
$("stage-out").addEventListener("change", outputChanged);
$("stage-devices").addEventListener("click", revealDevices);
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listDevices);
$("stage-stop").addEventListener("click", stopStage);
{
  const f = params.get("flow") || store.get("vf-flow") || "one";
  const r = document.querySelector('input[name="flow"][value="' + (f === "stage" ? "stage" : "one") + '"]');
  r.checked = true; setFlow(r.value);
}
syncStageStart();
$("demo").addEventListener("click", useDemoClip);
$("wd-plain").addEventListener("click", usePlainText);
$("wd-retry").addEventListener("click", retryJob);
// Remember names between visits (per-browser convenience only; the page works without storage).
$("terms").value = store.get("vf-terms") || "";
$("terms").addEventListener("input", () => store.set("vf-terms", $("terms").value));
$("first-run").hidden = store.get("vf-seen") === "1";
$("first-run-close").addEventListener("click", () => { store.set("vf-seen", "1"); $("first-run").hidden = true; $("record").focus(); });
$("mock-toggle").checked = app.mock;
$("mock-toggle").addEventListener("change", (e) => { app.mock = e.target.checked; refreshHealth(); });
const _p = supportProblem();
if (_p) { $("rec-hint").textContent = _p; }
recUi("idle");
stopMeter();
syncSteps();
refreshHealth(); setInterval(refreshHealth, 15000);
