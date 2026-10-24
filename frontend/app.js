// VoiceFlow frontend: vanilla JS, no build step. Shapes mirror types.ts / docs/md/10-api-contract.md.
"use strict";

const $ = (id) => document.getElementById(id);
const MAX_SECONDS = 45;
const STAGE_MAP = { convert: "convert", asr: "hear", decide: "decide", rewrite: "edit", guard: "verify" };
const STAGE_LABEL = { convert: "Converting audio", hear: "Listening to what you said", decide: "Deciding how to tidy it", edit: "Editing", verify: "Checking the meaning", ready: "Ready" };

const app = {
  mock: new URLSearchParams(location.search).get("mock") === "1",
  health: null,
  job: null,
  blob: null,          // last recording, kept in memory only (for "Play original")
  recorder: null, stream: null, chunks: [], recStart: 0, timerId: 0, audioCtx: null, raf: 0,
  es: null, pollId: 0,
  twinlyOnline: true,
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

function showError(message, hint, state = "error") {
  setState(state);
  $("error-msg").textContent = message;
  $("error-hint").textContent = hint || "";
  $("error").hidden = false;
  setStatus("Something went wrong. " + (hint || ""));
}
function clearError() { $("error").hidden = true; }

// Uniform backend errors: {error:{code,message,hint}}
async function api(path, opts) {
  let res;
  try { res = await fetch(path, opts); }
  catch (e) { throw { code: "network", message: "Can't reach the VoiceFlow server.", hint: "Is it running? Try `make run` and reload." }; }
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
  // Prefer a real recorded clip shipped with the frontend; fall back to silence for mock runs.
  for (const url of ["demo-clip.m4a", "demo-clip.webm", "demo-clip.wav"]) {
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
  app.job = null;
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
  app.blob = blob;
  $("original").disabled = false;
  resetStages();
  setState("uploading");
  setStatus("Uploading your recording…");
  $("timer").textContent = "0:00 / " + fmtTime(MAX_SECONDS);
  try {
    if (app.mock) return await runMock(blob);
    const fd = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("wav") ? "wav" : "webm";
    fd.append("audio", blob, "recording." + ext);
    fd.append("mode", currentMode());
    const terms = $("terms").value.trim();
    if (terms) fd.append("protected_terms", terms);
    const { job_id } = await api("/api/process", { method: "POST", body: fd });
    watchJob(job_id);
  } catch (e) { showError(e.message || "Upload failed.", e.hint); }
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
    es.addEventListener("stage", (m) => handleStage(JSON.parse(m.data)));
    es.addEventListener("result", (m) => { done(); handleJob(JSON.parse(m.data)); });
    es.addEventListener("error", (m) => {
      if (finished) return;
      if (m && m.data) { // a real `error` event from the server
        done();
        let msg = "The job failed."; try { msg = JSON.parse(m.data).message || msg; } catch {}
        showError(msg, "Try again, or press \"Use demo clip\".");
      } else { es.close(); app.es = null; startPolling(id); } // connection problem
    });
  } catch { startPolling(id); }
}

function startPolling(id) {
  if (app.pollId) return;
  app.pollId = setInterval(async () => {
    try {
      const job = await api("/api/jobs/" + encodeURIComponent(id));
      applyTrace(job.trace || []);
      if (job.status === "ready" || job.status === "failed") { closeJobStreams(); handleJob(job); }
    } catch (e) { closeJobStreams(); showError(e.message, e.hint); }
  }, 800);
}

// Polling has no stage events, so derive the timeline from the job's trace.
function applyTrace(trace) {
  for (const t of trace) handleStage({ stage: t.stage, status: t.ok ? "done" : "error", ms: t.ms });
  const last = trace.length ? trace[trace.length - 1].stage : null;
  const order = ["convert", "asr", "decide", "rewrite", "guard"];
  const next = order[order.indexOf(last) + 1];
  if (next) handleStage({ stage: next, status: "start" });
}

function handleStage(ev) {
  const name = STAGE_MAP[ev.stage];
  if (!name) return;
  const li = document.querySelector('#stages li[data-stage="' + name + '"]');
  if (!li) return;
  if (li.dataset.status === "done" && ev.status === "start") return;
  li.dataset.status = ev.status;
  if (ev.ms != null && ev.status !== "start") li.querySelector(".s-ms").textContent = fmtMs(ev.ms);
  const words = { start: STAGE_LABEL[name] + "…", done: STAGE_LABEL[name] + ": done" + (ev.ms != null ? " in " + fmtMs(ev.ms) : ""), error: STAGE_LABEL[name] + " had a problem", fallback: STAGE_LABEL[name] + ": using a safer fallback" };
  setStatus(words[ev.status] || "");
  if (document.body.dataset.state === "uploading") setState("processing");
}

function handleJob(job) {
  if (job.status === "failed") { showError("We couldn't process that recording.", "Try speaking a little closer to the microphone, or press \"Use demo clip\"."); return; }
  app.job = job;
  const ready = document.querySelector('#stages li[data-stage="ready"]');
  ready.dataset.status = "done";
  ready.querySelector(".s-ms").textContent = job.timings ? fmtMs(job.timings.total_ms) : "";
  document.querySelectorAll("#stages li").forEach((li) => { if (li.dataset.status === "idle" || li.dataset.status === "start") li.dataset.status = "done"; });
  setMode(job.mode_used);
  renderJob(job, true);
}

// ---------- offline demo pipeline (no server) ----------
async function runMock(blob) {
  setState("processing");
  const base = await (await fetch("mock-job.json")).json();
  const steps = [["convert", 140], ["asr", 900], ["decide", 600], ["rewrite", 800], ["guard", 500]];
  for (const [stage, ms] of steps) {
    handleStage({ stage, status: "start" });
    await sleep(ms);
    handleStage({ stage, status: "done", ms });
  }
  const mode = currentMode();
  base.mode_used = mode === "auto" ? base.decisions.recommended_mode : mode;
  handleJob(base);
}
function mockGuard(text) {
  const bad = /\bfriday\b/i.test(text);
  const violations = bad ? [{ rule: "self_correction", original_span: "Friday (superseded by Monday)", rewrite_span: "Friday", message: "You corrected Friday to Monday, but the text still says Friday." }] : [];
  return { pass: !bad, violations, decisions_probs: { meaning_preserved: bad ? 0.31 : 0.97, changed_number_date_or_name: bad ? 0.88 : 0.04 }, verifier: "online" };
}

// ---- placeholder until checkpoint 3 ----
function renderJob(job) { $("result").hidden = false; $("verbatim").textContent = job.verbatim; $("final-text").value = job.rewrite; setState("ready"); }
function syncSpeakButton() {}
function stopPlayback() {}
// ---- wiring ----
$("record").addEventListener("click", toggleRecord);
$("demo").addEventListener("click", useDemoClip);
$("error-dismiss").addEventListener("click", () => { clearError(); setState("idle"); setStatus("Ready when you are."); });
$("mock-toggle").checked = app.mock;
$("mock-toggle").addEventListener("change", (e) => { app.mock = e.target.checked; refreshHealth(); });
const _p = supportProblem();
if (_p) { $("rec-hint").textContent = _p; }
refreshHealth(); setInterval(refreshHealth, 15000);
