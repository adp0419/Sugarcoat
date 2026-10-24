// VoiceFlow frontend: vanilla JS, no build step. Shapes mirror types.ts / docs/md/10-api-contract.md.
"use strict";

const $ = (id) => document.getElementById(id);
const MAX_SECONDS = 45;
const STAGE_MAP = { convert: "convert", asr: "hear", decide: "decide", rewrite: "edit", guard: "verify" };
const STAGE_LABEL = { convert: "Converting audio", hear: "Listening to what you said", decide: "Deciding how to tidy it", edit: "Editing", verify: "Checking the meaning", ready: "Ready" };

const params = new URLSearchParams(location.search);
const app = {
  mock: params.get("mock") === "1",
  hang: params.get("hang") === "1" ? "rewrite" : params.get("hang"), // test toggle: offline mock never finishes this stage
  health: null,
  job: null,
  jobId: null,         // id of the job being processed (app.job is only set once it is ready)
  blob: null,          // last recording, kept in memory only (for "Play original")
  recorder: null, stream: null, chunks: [], recStart: 0, timerId: 0, audioCtx: null, raf: 0,
  es: null, pollId: 0, runId: 0,
  twinlyOnline: true,
  blockedJobs: new Set(), // jobs that got job_unverified: never resend (docs/md/CLAUDE.md rule 6)
  wd: null,
};

// ---------- small helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "tabindex") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const k of kids) n.append(k);
  return n;
}
const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + " s" : Math.round(ms) + " ms");
const pct = (p) => Math.round(p * 100) + "%";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setState(s) { document.body.dataset.state = s; }
function setStatus(text) { $("status").textContent = text; }
function showBanner(text) { const b = $("banner"); b.textContent = text; b.hidden = !text; }

// near = "speak" shows the box under the Approve button the user just pressed; otherwise above the results.
function showError(message, hint, state = "error", steps = [], near = "home") {
  setState(state);
  $(near === "speak" ? "error-speak" : "error-home").after($("error"));
  $("error-msg").textContent = message;
  $("error-hint").textContent = hint || "";
  $("error-steps").replaceChildren(...steps.map((s) => el("li", { text: s })));
  $("error-steps").hidden = !steps.length;
  $("error").hidden = false;
  $("error").scrollIntoView({ block: "nearest" });
  setStatus(message + " " + (hint || ""));
}
function clearError() { $("error").hidden = true; }

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

// ---------- health (status dots) ----------
function dot(id, s, label) { $("dot-" + id).dataset.s = s; $("sr-" + id).textContent = "(" + label + ")"; }

async function refreshHealth() {
  try {
    const h = app.mock ? { asr_loaded: true, decisions: "ok", gemma: "ok", twinly: { online: true, voice_ready: true }, mock: true } : await api("/api/health");
    app.health = h;
    dot("asr", h.asr_loaded ? "ok" : "error", h.asr_loaded ? "ready" : "not loaded");
    dot("decisions", h.decisions === "ok" ? "ok" : h.decisions === "off" ? "off" : "error", h.decisions === "ok" ? "ready" : h.decisions === "off" ? "off, using fixed rules only" : "error");
    dot("gemma", h.gemma === "ok" ? "ok" : "error", h.gemma === "ok" ? "ready" : "error");
    const tw = h.twinly && h.twinly.online && h.twinly.voice_ready;
    dot("twinly", tw ? "ok" : "error", tw ? "ready" : h.twinly && h.twinly.online ? "voice not set up" : "offline");
    app.twinlyOnline = !!tw;
    document.body.dataset.twinly = tw ? "online" : "offline";
    let note = "";
    if (h.mock) note = "Demo mode: the server is using recorded sample data, not live services.";
    if (!tw) note = (note ? note + " " : "") + "Your voice isn't available right now (Twinly is offline or not set up). You can still record and get the cleaned-up text, but speaking is switched off.";
    if (h.decisions === "off") note = (note ? note + " " : "") + "The AI verifier is off; only the fixed meaning checks are running.";
    showBanner(note);
  } catch (e) {
    ["asr", "decisions", "gemma", "twinly"].forEach((k) => dot(k, "error", "unreachable"));
    showBanner("Can't reach the VoiceFlow server. You can still try the page with offline demo data (footer).");
  }
  syncSpeakButton();
}

// ---------- recording ----------
const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || "";
}
function supportProblem() {
  if (!window.isSecureContext) return "Recording needs https or localhost. Open this page at http://localhost:8000.";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === "undefined")
    return "This browser can't record audio. Please use Chrome on desktop, or press \"Use demo clip\".";
  return "";
}

function fmtTime(s) { return Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"); }

async function startRecording() {
  clearError();
  stopPlayback(); // cancel any chained playback before the mic opens
  const problem = supportProblem();
  if (problem) { showError("Recording isn't available here.", problem, "unsupported"); return; }
  try {
    app.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // first click, not on load
  } catch (e) {
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError"))
      showError("Microphone blocked.", "Click the lock icon in the address bar, allow the microphone, then press Record again.", "mic-denied");
    else if (e && e.name === "NotFoundError")
      showError("No microphone found.", "Plug one in or choose one in your system sound settings, then try again.", "mic-denied");
    else showError("Couldn't start the microphone.", (e && e.message) || "Try reloading the page.", "error");
    return;
  }
  const mime = pickMime();
  try { app.recorder = new MediaRecorder(app.stream, mime ? { mimeType: mime } : undefined); }
  catch (e) { stopStream(); showError("This browser can't record here.", "Please use Chrome on desktop, or press \"Use demo clip\".", "unsupported"); return; }
  app.chunks = [];
  app.recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) app.chunks.push(ev.data); };
  app.recorder.onstop = () => {
    const type = app.recorder.mimeType || mime || "audio/webm";
    const blob = new Blob(app.chunks, { type });
    stopStream();
    if (blob.size < 500) { showError("That recording was empty.", "Check your microphone and try again.", "error"); return; }
    submitAudio(blob);
  };
  app.recorder.start(250);
  app.recStart = Date.now();
  setState("recording");
  resetResult();
  $("record").setAttribute("aria-pressed", "true");
  $("record-label").textContent = "Stop";
  setStatus("Recording. Press Space or Stop when you're done.");
  app.timerId = setInterval(tick, 200);
  drawWave();
}

function tick() {
  const s = (Date.now() - app.recStart) / 1000;
  $("timer").textContent = fmtTime(s) + " / " + fmtTime(MAX_SECONDS);
  if (s >= MAX_SECONDS) stopRecording();
}

function stopRecording() {
  if (!app.recorder || app.recorder.state === "inactive") return;
  clearInterval(app.timerId);
  cancelAnimationFrame(app.raf);
  $("record").setAttribute("aria-pressed", "false");
  $("record-label").textContent = "Record";
  app.recorder.stop();
}
function stopStream() {
  if (app.stream) app.stream.getTracks().forEach((t) => t.stop());
  app.stream = null;
  if (app.audioCtx) { app.audioCtx.close().catch(() => {}); app.audioCtx = null; }
}
function toggleRecord() { (document.body.dataset.state === "recording" ? stopRecording : startRecording)(); }

function drawWave() {
  const canvas = $("wave"), g = canvas.getContext("2d");
  try {
    app.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const an = app.audioCtx.createAnalyser(); an.fftSize = 64;
    app.audioCtx.createMediaStreamSource(app.stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const color = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#1d4ed8";
    const frame = () => {
      an.getByteFrequencyData(data);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = color;
      const w = canvas.width / data.length;
      data.forEach((v, i) => { const h = Math.max(3, (v / 255) * canvas.height); g.fillRect(i * w + 1, (canvas.height - h) / 2, w - 2, h); });
      app.raf = requestAnimationFrame(frame);
    };
    frame();
  } catch { /* waveform is decoration only */ }
}

// Space toggles record unless the user is typing or on another control.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.closest("input, textarea, select, button, summary, a, audio") || t.isContentEditable)) return;
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
async function useDemoClip() {
  clearError();
  resetResult();
  // demo-clip.m4a is a macOS `say` voice reading the canonical messy announcement (not a person). Falls back to silence for mock runs.
  for (const url of ["demo-clip.m4a"]) {
    try {
      const r = await fetch(url);
      const type = r.headers.get("content-type") || "";
      if (r.ok && type.startsWith("audio/")) { submitAudio(await r.blob()); return; }
    } catch { /* try next */ }
  }
  submitAudio(silentWav());
}

// ---------- upload + job lifecycle ----------
function resetStages() {
  document.querySelectorAll("#stages li").forEach((li) => { li.dataset.status = "idle"; li.querySelector(".s-ms").textContent = ""; });
  $("rung").hidden = true;
}
function resetResult() {
  closeJobStreams();
  stopWatchdog();
  app.runId++;
  app.job = null; app.jobId = null;
  $("result").hidden = true;
  $("output").hidden = true;
  $("override").checked = false;
  $("bad").checked = false;
  stopPlayback();
  resetStages();
  clearError();
}
function closeJobStreams() {
  if (app.es) { app.es.close(); app.es = null; }
  clearInterval(app.pollId); app.pollId = 0;
}

function currentMode() { return document.querySelector('input[name="mode"]:checked').value; }
function setMode(m) { const r = document.querySelector('input[name="mode"][value="' + m + '"]'); if (r) r.checked = true; }

async function submitAudio(blob) {
  closeJobStreams();
  app.runId++;
  app.job = null; app.jobId = null;
  app.blob = blob;
  $("original").disabled = false;
  $("result").hidden = true;
  clearError();
  resetStages();
  setState("uploading");
  setStatus("Uploading your recording…");
  $("timer").textContent = "0:00 / " + fmtTime(MAX_SECONDS);
  startWatchdog();
  const run = app.runId;
  try {
    if (app.mock) return await runMock(run);
    const fd = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("wav") ? "wav" : "webm";
    fd.append("audio", blob, "recording." + ext);
    fd.append("mode", currentMode());
    const terms = $("terms").value.trim();
    if (terms) fd.append("protected_terms", terms);
    const { job_id } = await api("/api/process", { method: "POST", body: fd });
    if (run !== app.runId) return;
    app.jobId = job_id;
    noteProgress();
    watchJob(job_id);
  } catch (e) { if (run === app.runId) { stopWatchdog(); showError(e.message || "Upload failed.", e.hint); } }
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
        showError(e.message || "The job failed.", e.hint || "Try again, or press \"Use demo clip\".");
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
      closeJobStreams(); stopWatchdog(); showError(e.message, e.hint);
    }
  }, 800);
}

// Polling has no stage events, so derive the timeline from the job's trace.
function applyTrace(trace) {
  for (const t of trace) handleStage({ stage: t.stage, status: t.ok ? "done" : "error", ms: t.ms, preview: t.error || "" }, true);
  const last = trace.length ? trace[trace.length - 1].stage : null;
  const order = ["convert", "asr", "decide", "rewrite", "guard"];
  const next = order[order.indexOf(last) + 1];
  if (next) handleStage({ stage: next, status: "start" }, true);
}

function handleStage(ev, quiet) {
  const name = STAGE_MAP[ev.stage];
  if (!name) return;
  const li = document.querySelector('#stages li[data-stage="' + name + '"]');
  if (!li) return;
  if (quiet && li.dataset.status === ev.status) return;
  if (li.dataset.status === "done" && ev.status === "start" && quiet) return;
  li.dataset.status = ev.status;
  if (ev.ms != null && ev.status !== "start") li.querySelector(".s-ms").textContent = fmtMs(ev.ms);
  if (ev.status === "start") wdStage(name);
  else if (app.wd && app.wd.stage === name) app.wd.stage = null;
  const words = {
    start: STAGE_LABEL[name] + "…",
    done: STAGE_LABEL[name] + ": done" + (ev.ms != null ? " in " + fmtMs(ev.ms) : ""),
    error: explainFailure(ev.stage, ev.preview) + " Trying a safer fallback…",
    fallback: STAGE_LABEL[name] + ": " + (ev.preview || "using a safer fallback") + ".",
  };
  setStatus(words[ev.status] || "");
  if (document.body.dataset.state === "uploading") setState("processing");
}

function handleJob(job) {
  stopWatchdog();
  if (job.status === "failed") {
    const e = job.error || {};
    showError(e.message || "We couldn't process that recording.", e.hint || "Try speaking a little closer to the microphone, or press \"Use demo clip\".");
    return;
  }
  app.job = job;
  const ready = document.querySelector('#stages li[data-stage="ready"]');
  ready.dataset.status = "done";
  ready.querySelector(".s-ms").textContent = job.timings && job.timings.total_ms ? fmtMs(job.timings.total_ms) : "";
  document.querySelectorAll("#stages li").forEach((li) => { if (li.dataset.status === "idle" || li.dataset.status === "start") li.dataset.status = "done"; });
  if (job.mode_used) setMode(job.mode_used);
  renderJob(job, true);
}

// ---------- client-side watchdog ----------
// The UI never trusts the backend to finish: it warns after 15 s of silence or when a stage runs past
// 2x its budget (docs/md/03), offers a way out, and gives up at 60 s.
const STALL_MS = 15000, HARD_STOP_MS = 60000;
const BUDGET_MS = { upload: 5000, convert: 500, hear: 6000, decide: 3000, edit: 5000, verify: 3000 };
const WHO = { upload: "The upload", convert: "Converting the audio", hear: "Speech recognition", decide: "The analysis service (OpenAI Decisions)", edit: "The AI editor (Gemma 4)", verify: "The meaning check" };
const SLOW_TEXT = {
  upload: "Uploading is taking longer than usual. The server may be busy.",
  convert: "Converting the audio is taking longer than usual.",
  hear: "Speech recognition is taking longer than usual. The first run after the server starts can be slow while the model loads.",
  decide: "The analysis service (OpenAI Decisions) is slow to answer.",
  edit: "The AI editor (Gemma 4) is taking longer than usual. It normally answers in under 10 seconds.",
  verify: "The meaning check is slow to answer.",
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
  const li = wd.stage && document.querySelector('#stages li[data-stage="' + wd.stage + '"]');
  if (li && li.dataset.status === "start") li.querySelector(".s-ms").textContent = Math.floor(stageMs / 1000) + " s";
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
    $("wd-plain").disabled = false;
  }
  $("watch-time").textContent = "Waiting " + Math.floor(total / 1000) + " s so far. We'll stop waiting at " + HARD_STOP_MS / 1000 + " s.";
}

function hardStop() {
  const stage = app.wd && app.wd.stage;
  closeJobStreams();
  stopWatchdog();
  app.runId++; // ignore anything the stuck job sends later
  const li = stage && document.querySelector('#stages li[data-stage="' + stage + '"]');
  if (li) li.dataset.status = "error";
  setState("error");
  $("watch-msg").textContent = "We stopped waiting after 60 seconds: " + (WHO[stage] || "the server") + " didn't finish. " +
    "Use your words without the AI edit, or try again.";
  $("watch-time").textContent = "";
  $("watch").hidden = false;
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
  ["edit", "verify"].forEach((s) => { const li = document.querySelector('#stages li[data-stage="' + s + '"]'); if (li.dataset.status !== "done") li.dataset.status = "fallback"; });
  handleJob(job);
  checkEdited(); // run the meaning check on the plain text (guard only, no AI edit)
}

// Way out #2: send the same recording again.
function retryJob() {
  if (!app.blob) { stopWatchdog(); setState("idle"); setStatus("Record again, or press Use demo clip."); $("record").focus(); return; }
  submitAudio(app.blob);
}

// ---------- offline demo pipeline (no server) ----------
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
  const mode = currentMode();
  base.mode_used = mode === "auto" ? base.decisions.recommended_mode : mode;
  base.protected_terms = $("terms").value.split(",").map((t) => t.trim()).filter(Boolean);
  handleJob(base);
}
function mockGuard(text) {
  const bad = /\bfriday\b/i.test(text);
  const violations = bad ? [{ rule: "self_correction", original_span: "Friday (superseded by Monday)", rewrite_span: "Friday", message: "You corrected Friday to Monday, but the text still says Friday." }] : [];
  return { pass: !bad, violations, decisions_probs: { meaning_preserved: bad ? 0.31 : 0.97, changed_number_date_or_name: bad ? 0.88 : 0.04 }, verifier: "online" };
}

// ---------- rendering: two columns, diff, panels ----------
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
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "eq") { box.append(ops[k].w + " "); k++; continue; }
    const dels = [], inss = [];
    while (k < ops.length && ops[k].t !== "eq") { (ops[k].t === "del" ? dels : inss).push(ops[k].w); k++; }
    const d = dels.join(" "), n = inss.join(" ");
    const reason = reasonFor(d, n, app.job.edits, edited);
    const h = el("span", { class: "hunk", tabindex: "0" });
    if (d) h.append(el("del", { text: d }), " ");
    if (n) h.append(el("ins", { text: n }), " ");
    h.append(el("span", { class: "chip", role: "note", text: reason }), " ");
    box.append(h);
  }
  renderNames();
}

const PRED_LABEL = {
  has_filler: "Filler words", has_repetition: "Repeated words", has_self_correction: "Self-correction",
  has_false_start: "False start", is_incomplete_thought: "Unfinished thought", contains_hedging: "Hedging (maybe, I think)",
  is_already_fluent: "Already fluent",
};
function renderDecisions(d) {
  const chips = $("chips"), bars = $("bars"); chips.replaceChildren(); bars.replaceChildren();
  if (!d) { chips.append(el("span", { class: "muted", text: "No analysis available for this run." })); return; }
  if (d.recommended_mode) chips.append(el("span", { class: "chip-pill", text: "Suggested mode: " + d.recommended_mode }));
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
function renderGuard(g) {
  const v = $("guard-verdict"), list = $("guard-rules"); list.replaceChildren();
  if (!g) { v.textContent = "Not checked yet."; v.dataset.pass = ""; return; }
  v.dataset.pass = String(!!g.pass);
  v.textContent = g.pass ? "✓ Passed: the meaning is the same as what you said." : "✗ Blocked: this text may not mean what you said.";
  const hits = new Map(); const other = [];
  for (const x of g.violations || []) {
    const rule = typeof x === "string" ? { rule: "", message: x } : x;
    const idx = /^\d+$/.test(String(rule.rule)) ? Number(rule.rule) - 1 : -1;
    const match = GUARD_RULES.find((r, i) => i === idx || r.re.test(rule.rule || ""));
    if (match) { if (!hits.has(match.id)) hits.set(match.id, []); hits.get(match.id).push(rule); } else other.push(rule);
  }
  const why = (r) => r.message || ((r.original_span || "") + " → " + (r.rewrite_span || ""));
  for (const r of GUARD_RULES) {
    const f = hits.get(r.id);
    const li = el("li", { "data-ok": String(!f) }, r.text);
    if (f) f.forEach((x) => li.append(el("span", { class: "why", text: why(x) })));
    list.append(li);
  }
  for (const x of other) list.append(el("li", { "data-ok": "false" }, "Another check failed", el("span", { class: "why", text: why(x) })));
  const mp = (g.decisions_probs || {}).meaning_preserved;
  $("guard-note").textContent = g.verifier === "offline"
    ? "AI verifier offline: only the fixed checks above ran."
    : mp != null ? "AI second opinion: " + pct(mp) + " sure the meaning is preserved." : "";
}

// ---------- plain-English explanations ----------
const SERVICE = {
  convert: "Converting the audio", asr: "Speech recognition", decide: "The analysis service (OpenAI Decisions)",
  rewrite: "The AI editor (Gemma 4)", guard: "The meaning check", speak: "Twinly",
};
// Raw errors like "ClientError: 401 UNAUTHENTICATED" -> a short reason. Order matters: most specific first.
const ERROR_REASONS = [
  [/\b401\b|\b403\b|unauthen|unauthori|api.?key|permission|access_token/i, "rejected our API key"],
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
  if ((job.notes || []).some((n) => /watchdog/i.test(n))) return "The AI steps took too long and the server stopped waiting";
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
    case "minimal": return cause + ", so we only removed filler words (um, uh) and repeated words. Nothing was reworded, and no names, numbers, or dates were changed.";
    case "original": return cause + ", so nothing was changed: the text below is exactly what we heard. You can still edit it yourself before approving.";
    case "local": return "You chose to skip the AI edit. We removed filler sounds (um, uh) and repeated words in your browser; nothing else was changed, so self-corrections like \u201cFriday, no wait, Monday\u201d stay as you said them. Edit the text if you like; the meaning check runs before you can speak it.";
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
  [/decisions api (unavailable|disabled)/i, "The analysis service (OpenAI Decisions) was unavailable, so we used Natural mode and the fixed meaning checks only."],
  [/guard not available/i, "The meaning check wasn't available, so this text is NOT verified. Read it carefully before approving."],
  [/watchdog|no changes made/i, null], // covered by the rung box
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
      el("td", { text: t.stage + (t.ok ? "" : " ✗ failed") }),
      el("td", { text: fmtMs(t.ms || 0) }),
      el("td", { text: t.model || "-" }),
      note));
  }
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
function renderNames() {
  const job = app.job, list = $("names-list"); list.replaceChildren();
  const terms = job ? termsFor(job) : [];
  $("names").hidden = !terms.length;
  const final = $("final-text").value;
  for (const term of terms) {
    const heard = hasPhrase(job.verbatim || "", term), kept = hasPhrase(final, term);
    const near = heard ? null : closestPhrase(job.verbatim || "", term);
    let s = "ok", msg;
    if (heard && kept) msg = "Heard correctly and kept in the final text.";
    else if (heard) { s = "warn"; msg = "Heard correctly, but it is missing from the final text. Check the edit before approving."; }
    else if (kept) msg = near ? "Speech recognition heard “" + near + "”; the final text uses “" + term + "”." : "Not heard in the recording, but the final text includes it.";
    else if (near) { s = "warn"; msg = "Speech recognition heard “" + near + "” instead."; }
    else { s = "none"; msg = "Not found in what we heard."; }
    const li = el("li", { "data-s": s }, el("span", { class: "term", text: term }), el("span", { text: msg }));
    if (!heard && !kept && near && hasPhrase(final, near)) {
      const b = el("button", { type: "button", class: "secondary", text: "Use “" + term + "” in the final text" });
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
  ta.focus();
}

function renderJob(job, fresh) {
  $("result").hidden = false;
  renderVerbatim(job.verbatim || "");
  if (fresh) { $("final-text").value = job.rewrite || ""; app.baseRewrite = job.rewrite || ""; }
  renderDiff();
  renderDecisions(job.decisions);
  renderGuard(job.guard);
  renderTrace(job.trace);
  renderRung(job);
  renderNotes(job.notes);
  $("override").checked = false;
  const ok = !job.guard || job.guard.pass;
  $("override-wrap").hidden = ok;
  setState(ok ? "ready" : "guard-failed");
  setStatus(ok ? "Ready. Check the text, then approve it to hear it in your voice." : "The meaning check blocked this text. Review it below.");
  syncSpeakButton();
}

// ---------- editing, re-running, simulate-bad ----------
let editTimer = 0, editSeq = 0;

function finalText() { return $("final-text").value.trim(); }

function syncSpeakButton() {
  const b = $("speak");
  const st = document.body.dataset.state;
  const busy = st === "speaking" || app.checking;
  const guardOk = !!app.job && (!app.job.guard || app.job.guard.pass || $("override").checked);
  const blocked = !!app.job && app.blockedJobs.has(app.job.id);
  b.disabled = busy || blocked || !app.job || !finalText() || !guardOk || !app.twinlyOnline;
  b.textContent = st === "speaking" ? "Generating your voice…"
    : blocked ? "Not resent: check Twinly first"
    : app.checking ? "Checking your edit…"
    : !app.twinlyOnline ? "Your voice is offline (text only)"
    : "Approve & speak in my voice";
  b.title = blocked ? "Twinly couldn't confirm this line. Resending could charge twice, so speaking is locked for this recording. Record again to start fresh."
    : !app.twinlyOnline ? "Twinly is offline or not set up, so speaking is switched off. Use Copy text instead."
    : (app.job && !guardOk) ? "The meaning check blocked this text. Tick the override box to speak it anyway." : "";
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
  app.checking = true; syncSpeakButton(); setStatus("Checking your edit…");
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
$("override").addEventListener("change", syncSpeakButton);

$("bad").addEventListener("change", (e) => {
  if (!app.job) { e.target.checked = false; return; }
  const base = app.baseRewrite || app.job.rewrite || "";
  $("final-text").value = e.target.checked
    ? (/\bmonday\b/i.test(base) ? base.replace(/\bmonday\b/i, "Friday") : base + " See you Friday.")
    : base;
  renderDiff(); clearTimeout(editTimer); checkEdited();
});

const MODE_CYCLE = ["minimal", "natural", "presenter"];
$("another").addEventListener("click", async () => {
  if (!app.job) { $("record").focus(); setStatus("Record something first, then try another mode."); return; }
  const used = app.job.mode_used;
  const chosen = currentMode();
  const next = chosen !== "auto" && chosen !== used ? chosen : MODE_CYCLE[(MODE_CYCLE.indexOf(used) + 1) % MODE_CYCLE.length];
  setMode(next);
  clearError(); app.checking = true; syncSpeakButton();
  setStatus("Re-editing in " + next + " mode…");
  try {
    let res;
    if (app.mock) { await sleep(700); res = mockMode(next); }
    else res = await api("/api/rewrite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: app.job.id, mode: next }) });
    Object.assign(app.job, res);
    app.job.mode_used = next;
    app.baseRewrite = app.job.rewrite;
    $("bad").checked = false;
    app.checking = false;
    renderJob(app.job, true);
  } catch (e) { app.checking = false; showError(e.message, e.hint); }
  syncSpeakButton();
});
function mockMode(mode) {
  const t = { minimal: "The team meeting is on Monday at five p m. And everyone should bring their laptops.", natural: "The team meeting is on Monday at five p m. Everyone should bring their laptops.", presenter: "Team meeting: Monday, five p m. Please bring your laptops." }[mode];
  return { rewrite: t, guard: mockGuard(t), edits: app.job.edits, mode_used: mode };
}

$("copy").addEventListener("click", async () => {
  const t = $("final-text").value;
  try { await navigator.clipboard.writeText(t); }
  catch { $("final-text").select(); document.execCommand("copy"); }
  $("copy-note").textContent = "Copied.";
  setTimeout(() => { $("copy-note").textContent = ""; }, 2000);
});

// ---------- speaking + chained playback ----------
const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";
const player = $("player");
let orig = null, playId = 0;

function stopPlayback() {
  playId++;
  player.pause(); player.removeAttribute("src"); player.load();
  if (orig) { orig.pause(); orig = null; }
}

$("original").addEventListener("click", () => {
  if (!app.blob) return;
  stopPlayback();
  orig = new Audio(URL.createObjectURL(app.blob));
  orig.play().catch(() => setStatus("Your browser couldn't play the original recording."));
  setStatus("Playing your original recording.");
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
  // Prime the audio element inside the click so later play() calls are allowed.
  stopPlayback();
  player.src = SILENT; player.play().catch(() => {});
  clearError();
  const text = finalText();
  setState("speaking"); syncSpeakButton();
  setStatus("Generating your voice. This can take up to 20 seconds…");
  $("output").hidden = false; $("out-meta").textContent = ""; $("downloads").replaceChildren(); $("play-state").textContent = "";
  try {
    let res;
    if (app.mock) { await sleep(1500); res = { chunks: [{ url: toneWav(1.6, 440), seconds: 1.6, cached: false }, { url: toneWav(1.6, 554), seconds: 1.6, cached: false }], total_seconds: 3.2, ms: 1500 }; }
    else res = await api("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: app.job.id, text }) }, 120000);
    if (!res.chunks && res.speak_id) res = await pollSpeak(res.speak_id);
    showAudio(res);
  } catch (e) {
    $("output").hidden = true;
    showSpeakError(e);
  }
  if (document.body.dataset.state === "speaking") setState("ready");
  syncSpeakButton();
});

// Twinly failures -> what happened + exact fix steps. voice_starting arrives as code "internal" with a
// "still starting" message (backend/voice.py), so match on the message too.
const SPEAK_ERRORS = {
  voice_starting: { msg: "Your Twinly voice is still starting up.", hint: "This usually takes about a minute after Twinly opens.",
    steps: ["Keep the Twinly app open on the Mac.", "Wait about a minute.", "Press Approve & speak again."] },
  voice_not_set_up: { msg: "Your voice clone isn't set up in Twinly yet.", hint: "Speaking needs a built voice clone.", offline: true,
    steps: ["On the Mac, open Twinly and go to the Voice screen.", "Press Build my clone and wait until it says ready.", "Reload this page, then press Approve & speak."] },
  twinly_offline: { msg: "VoiceFlow can't reach the Twinly app.", hint: "The Mac may be asleep or Twinly's voice engine stopped.", offline: true,
    steps: ["Make sure the Mac is awake and Twinly is open and signed in.", "If it is, quit Twinly (Cmd+Q) and reopen it.", "Wait a minute. The speak button comes back when the \u201cYour voice\u201d dot at the top turns green."] },
  rate_limited: { msg: "Too many voice requests in a short time.", hint: "Twinly allows about 30 requests a minute, and the demo has a spending cap.",
    steps: ["Wait one minute.", "Press Approve & speak again.", "If it says the spend cap is reached, ask the team before trying more."] },
  job_unverified: { msg: "Twinly couldn't confirm whether it spoke this line.", hint: "Do not resend: sending again may charge twice. Speaking is locked for this recording.", lock: true,
    steps: ["Check the Twinly app on the Mac to see whether the line was generated.", "Do not press speak again for this recording.", "To try again, record again or press Use demo clip (that starts a new job)."] },
  approval: { msg: "Twinly is waiting for approval on the Mac.", hint: "Twinly asks the owner to allow API requests.",
    steps: ["On the Mac, open Twinly and approve the pending request.", "Press Approve & speak again."] },
  not_found: { msg: "The server restarted and forgot this recording.", hint: "Jobs live in memory only.",
    steps: ["Record again, or press Use demo clip."] },
  timeout: { msg: "Generating your voice took too long.", hint: "Twinly may be busy or its voice engine may have stopped.",
    steps: ["Check the Twinly app is open on the Mac.", "Wait a minute, then press Approve & speak again."] },
};
function speakErrorKind(e) {
  if (e.code === "voice_starting" || /still starting/i.test(e.message || "")) return "voice_starting";
  if (/approv/i.test(e.message || "") && /twinly/i.test(e.message || "")) return "approval";
  return SPEAK_ERRORS[e.code] ? e.code : null;
}
function showSpeakError(e) {
  const kind = speakErrorKind(e), info = SPEAK_ERRORS[kind];
  if (!info) { showError(e.message || "Couldn't generate audio.", e.hint || "Try again in a moment.", "error", [], "speak"); return; }
  if (info.lock && app.job) app.blockedJobs.add(app.job.id);
  if (info.offline) { app.twinlyOnline = false; document.body.dataset.twinly = "offline"; }
  const msg = kind === "rate_limited" && /spend cap/i.test(e.message || "") ? "The demo's voice spending cap is reached." : info.msg;
  showError(msg, info.hint + " Your text is still here to copy.", info.offline ? "twinly-offline" : "error", info.steps, "speak");
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
  $("out-meta").textContent = chunks.length + (chunks.length === 1 ? " part" : " parts") + ", " + (res.total_seconds || 0).toFixed(1) + " s of audio" + (res.ms ? ", generated in " + fmtMs(res.ms) : "") + (chunks.every((c) => c.cached) && chunks.length ? " (from cache)" : "");
  const dl = $("downloads"); dl.replaceChildren();
  chunks.forEach((c, i) => dl.append(el("a", { class: "btn", href: c.url, download: "voiceflow-" + (i + 1) + ".m4a", text: chunks.length > 1 ? "Download part " + (i + 1) : "Download audio" })));
  playChain(chunks);
}

function playChain(chunks) {
  const my = ++playId;
  let i = 0;
  const go = () => {
    if (my !== playId) return;
    if (i >= chunks.length) { setState("ready"); $("play-state").textContent = "Finished."; setStatus("Finished playing."); syncSpeakButton(); return; }
    player.src = chunks[i].url;
    if (chunks[i + 1]) { const warm = new Audio(); warm.preload = "auto"; warm.src = chunks[i + 1].url; } // preload next
    $("play-state").textContent = "Playing part " + (i + 1) + " of " + chunks.length + "…";
    setStatus($("play-state").textContent);
    setState("playing");
    player.play().catch(() => { $("play-state").textContent = "Press play on the audio bar to listen."; setState("ready"); });
    i++;
  };
  player.onended = go;
  go();
}

// ---- wiring ----
$("record").addEventListener("click", toggleRecord);
$("demo").addEventListener("click", useDemoClip);
$("wd-plain").addEventListener("click", usePlainText);
$("wd-retry").addEventListener("click", retryJob);
// Remember names between visits (per-browser convenience only; the page works without storage).
try { $("terms").value = localStorage.getItem("vf-terms") || ""; } catch {}
$("terms").addEventListener("input", () => { try { localStorage.setItem("vf-terms", $("terms").value); } catch {} });
$("error-dismiss").addEventListener("click", () => { clearError(); setState("idle"); setStatus("Ready when you are."); });
$("mock-toggle").checked = app.mock;
$("mock-toggle").addEventListener("change", (e) => { app.mock = e.target.checked; refreshHealth(); });
const _p = supportProblem();
if (_p) { $("rec-hint").textContent = _p; }
refreshHealth(); setInterval(refreshHealth, 15000);
