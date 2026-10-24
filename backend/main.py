"""FastAPI app + orchestrator (docs/md/02, 03, 10).

Job store is in-memory. Every stage appends a TraceEntry and pushes an SSE event. A stage failure never
kills the job: it takes the next fallback rung (retry stricter -> minimal -> original). Only ASR failure
or an empty transcript is fatal.
"""
import asyncio
import hashlib
import json
import os
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import asr, auth, decide, guard, mock, rewrite as rw, speakq, status, voice
from .config import settings
from .errors import ApiError, api_error
from .models import (
    Decisions, ErrorBody, GuardResult, HealthResponse, Job, LiveResponse, MeVoice, MeVoiceRequest, Mode,
    ProcessAccepted, RewriteRequest,
    SessionJob, SessionResponse, SpeakAccepted, SpeakRequest, SpeakResponse, SpeakStatus, TraceEntry,
    TwinlyHealth, Violation,
)

log = logging.getLogger("voiceflow")
logging.basicConfig(level=logging.INFO)

MAX_UPLOAD = 10 * 1024 * 1024
MAX_SPEAK_CHARS = 2400
MODES = ("minimal", "natural", "presenter")
HASH_NAME = re.compile(r"^(?:[0-9a-f]{64}|backup_demo)\.m4a$")
NOTE_SELF_CORRECTED = "Self-corrections fixed by rules (AI editor unavailable)"
FAST_SKIP_GEMMA_S = 600.0
FAST_GEMMA_S = 4.0  # stage mode: Gemma usually needs ~16 s, so this mostly means "rules unless Gemma is quick"
RULES_ONLY = "rules only, Decisions offline"
SESSION_TTL_S = 2 * 3600
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
# browsers send audio/webm;codecs=opus (Chrome/Firefox) or audio/mp4 (Safari); curl/tests send octet-stream
AUDIO_MIME = re.compile(r"^(?:audio/[\w.+-]+|video/(?:webm|mp4|quicktime)|application/octet-stream)?$")


# ---------------------------------------------------------------- job store / events
class JobState:
    def __init__(self, job: Job):
        self.job = job
        self.events: list[tuple[str, dict]] = []
        self.run_start = 0  # SSE replays from here (a re-run starts a new run)
        self.cond = asyncio.Condition()
        self.lock = asyncio.Lock()
        self.task: asyncio.Task | None = None


JOBS: dict[str, JobState] = {}


def _state(job_id: str) -> JobState:
    st = JOBS.get(job_id)
    if not st:
        raise api_error("not_found", "Unknown job.", "The server may have restarted. Record again.")
    return st


async def emit(st: JobState, event: str, data: dict) -> None:
    async with st.cond:
        st.events.append((event, data))
        st.cond.notify_all()


def _job_json(job: Job) -> dict:
    return job.model_dump(mode="json", by_alias=True)


def _preview(x: Any, n: int = 120) -> str:
    s = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False, default=str)
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


async def stage(st: JobState, name: str, fn: Callable[[], Awaitable[Any]], *, model: str | None = None,
                preview: Callable[[Any], str] = _preview, label: str = "") -> tuple[bool, Any]:
    """Run one stage: SSE start, time it, trace entry, SSE done/error. Returns (ok, result_or_exception)."""
    await emit(st, "stage", {"stage": name, "status": "start", "ms": 0, "preview": label})
    t = time.perf_counter()
    try:
        res = await fn()
        ok, err, pv = True, None, (label + " " if label else "") + preview(res)
    except Exception as e:  # noqa: BLE001 - stage failure is data, not a crash
        res, ok = e, False
        err = e.message if isinstance(e, ApiError) else f"{type(e).__name__}: {e}"
        pv = ""
        if not isinstance(e, (ApiError, NotImplementedError, rw.GemmaUnavailable)):  # expected; status logs changes
            log.warning("stage %s failed: %s", name, err)
    ms = int((time.perf_counter() - t) * 1000)
    st.job.trace.append(TraceEntry(stage=name, ok=ok, ms=ms, model=model, preview=pv.strip(), error=err))
    await emit(st, "stage", {"stage": name, "status": "done" if ok else "error", "ms": ms,
                             "preview": pv.strip() if ok else (err or "")})
    return ok, res


async def _fallback(st: JobState, stage_name: str, msg: str) -> None:
    await emit(st, "stage", {"stage": stage_name, "status": "fallback", "ms": 0, "preview": msg})


# ---------------------------------------------------------------- stage wrappers (real vs MOCK)
def _models() -> dict[str, str]:
    m = "mock" if settings.MOCK else None
    return {"asr": m or f"crisperwhisper-{settings.ASR_SIZE}", "decide": m or settings.DECISIONS_MODEL,
            "rewrite": m or settings.GEMMA_MODEL, "guard": m or "deterministic+decisions"}


async def _decide(verbatim: str, sentences: list[str]) -> Decisions:
    if settings.MOCK:
        return await mock.decide()
    if not settings.DECISIONS_ENABLED:
        return Decisions(available=False, recommended_mode="natural",
                         note="Decisions API disabled (DECISIONS_ENABLED=0); using Natural mode.")
    return await decide.analyze(verbatim, sentences)


async def _guard(verbatim: str, rewrite_text: str, mode: str = "natural", protected: list[str] | None = None,
                 rules_only: bool = False) -> GuardResult:
    if settings.MOCK:
        return await mock.guard(verbatim, rewrite_text)
    if rules_only:  # fast path: deterministic rules, no Decisions verifier call
        g = await asyncio.to_thread(guard.check_rules, verbatim, rewrite_text, mode, protected or ())
        return GuardResult(**{"pass": g.passed, "verifier": "offline",
                              "violations": [Violation(**v.to_dict()) for v in g.violations]})
    return await guard.check(verbatim, rewrite_text, mode, protected or ())


async def _rewrite(verbatim: str, mode: Mode, decisions: Decisions | None, violations: list[str] | None,
                   protected: list[str] | None = None, budget_s: float | None = None):
    if settings.MOCK:
        return await mock.rewrite(mode), "mock"
    return await rw.run(verbatim, mode, decisions, violations, protected, budget_s=budget_s)


def _guard_label(g: Any, fast: bool) -> str:
    """True model label for a finished guard stage (not the hoped-for one)."""
    if settings.MOCK:
        return "mock"
    if fast:
        return "rules only (fast mode)"
    return "rules + Decisions verifier" if isinstance(g, GuardResult) and g.verifier == "online" else RULES_ONLY


# ---------------------------------------------------------------- rewrite + guard with the fallback ladder
async def run_ladder(st: JobState, mode: Mode) -> None:
    """full -> retry (stricter, lists violated facts) -> minimal (deterministic) -> original. Always terminates."""
    job = st.job
    fast = job.fast
    job.mode_used = mode
    job.notes = [n for n in job.notes if not n.startswith(("ladder:", "AI editor unavailable")) and n != NOTE_SELF_CORRECTED]
    violations: list[str] | None = None
    guard_unavailable = False
    api_down = False  # rewrite call itself failed (auth/network): a stricter retry cannot help

    async def attempt(rung: str, label: str) -> bool:
        nonlocal violations, guard_unavailable, api_down
        ok, res = await stage(st, "rewrite", lambda: _rewrite(job.verbatim, mode, job.decisions, violations,
                                                              job.protected_terms, FAST_GEMMA_S if fast else None),
                              model=_models()["rewrite"], label=label, preview=lambda r: r[0].rewrite)
        if not ok:
            api_down = not isinstance(res, ValueError)  # ValueError covers bad JSON / sanity rejects
            if isinstance(res, rw.GemmaUnavailable):
                job.notes.append(f"AI editor unavailable: {res}")
            violations = [f"previous attempt failed: {res}"] if rung == "full" else violations
            return False
        result, model_used = res
        job.rewrite, job.edits = result.rewrite, result.edits
        return await check(rung)

    async def check(rung: str) -> bool:
        nonlocal violations, guard_unavailable
        ok, g = await stage(st, "guard", lambda: _guard(job.verbatim, job.rewrite, mode, job.protected_terms, fast),
                            model=_models()["guard"],
                            preview=lambda r: ("PASS" if r.pass_ else "FAIL: " + "; ".join(v.message for v in r.violations))
                            + f" (verifier {r.verifier})")
        job.trace[-1].model = _guard_label(g, fast)
        if not ok:
            if isinstance(g, NotImplementedError):  # T2 guard not landed yet: accept, but say so
                guard_unavailable = True
                job.guard = None
                job.notes.append("ladder: guard not available - rewrite is UNVERIFIED")
                job.rung = rung  # type: ignore[assignment]
                return True
            violations = None
            return False
        job.guard = g
        if g.verifier == "offline" and not fast:
            note = "AI verifier offline - deterministic checks only"
            if note not in job.notes:
                job.notes.append(note)
        if g.pass_:
            job.rung = rung  # type: ignore[assignment]
            return True
        violations = [v.message for v in g.violations] or ["meaning changed"]
        return False

    # fast path: don't spend ~0.3 s on a call that failed for account reasons in the last 10 min (then re-probe)
    down = None if settings.MOCK else status.recent("gemma", FAST_SKIP_GEMMA_S)
    if fast and down in ("no_credits", "auth_error"):
        job.trace.append(TraceEntry(stage="rewrite", ok=False, ms=0, model=_models()["rewrite"],
                                    error=f"skipped: Gemma {down} (last real call)"))
        await emit(st, "stage", {"stage": "rewrite", "status": "error", "ms": 0, "preview": f"skipped: Gemma {down}"})
        job.notes.append(f"AI editor unavailable: Gemma {down.replace('_', ' ')}")
    elif await attempt("full", ""):
        return
    if not api_down and not fast:  # fast path: no stricter retry
        await _fallback(st, "rewrite", "Rewrite rejected - retrying with a stricter prompt")
        if await attempt("retry", "retry (stricter)"):
            return

    await _fallback(st, "rewrite", "Falling back to minimal filler removal (no AI)")
    ok, res = await stage(st, "rewrite", lambda: _async(rw.minimal(job.verbatim, mode)), model="deterministic",
                          label="minimal" if mode == "minimal" else "minimal + self-corrections", preview=lambda r: r.rewrite)
    if ok:
        job.rewrite, job.edits = res.rewrite, res.edits
        if res.rewrite.strip() and await check("minimal"):
            if any(e.reason == "self_correction" for e in res.edits):
                job.notes.append(NOTE_SELF_CORRECTED)
            return

    await _fallback(st, "rewrite", "Using the original transcript - no changes made")
    job.rewrite, job.edits, job.rung = job.verbatim, [], "original"
    job.guard = GuardResult(**{"pass": True, "verifier": "offline"})
    job.notes.append("ladder: no changes made")


async def run_ladder_watched(st: JobState, mode: Mode, t0: float) -> None:
    """Watchdog: whatever a stage does, the job leaves the ladder before JOB_DEADLINE_S (from t0)."""
    left = settings.JOB_DEADLINE_S - (time.perf_counter() - t0)
    try:
        await asyncio.wait_for(run_ladder(st, mode), max(1.0, left))
    except asyncio.TimeoutError:
        job = st.job
        log.warning("job %s hit the %.0f s watchdog", job.id, settings.JOB_DEADLINE_S)
        await _fallback(st, "rewrite", "Took too long - using the original transcript")
        job.rewrite, job.edits, job.rung = job.verbatim, [], "original"
        job.guard = GuardResult(**{"pass": True, "verifier": "offline"})
        job.notes.append("ladder: watchdog timeout - no changes made")


async def _async(x):
    return x


async def resolve_mode(job: Job, requested: str) -> Mode:
    if requested in MODES:
        return requested  # type: ignore[return-value]
    return job.decisions.recommended_mode if job.decisions else "natural"


# ---------------------------------------------------------------- pipeline
async def finish(st: JobState, t0: float) -> None:
    job = st.job
    job.timings.total_ms = int((time.perf_counter() - t0) * 1000)
    job.status = "ready"
    settings.logs_dir.mkdir(exist_ok=True)
    try:
        (settings.logs_dir / f"{job.id}.json").write_text(json.dumps(_job_json(job), indent=1, ensure_ascii=False))
    except OSError:
        pass
    await emit(st, "result", _job_json(job))


async def fail(st: JobState, e: Exception, t0: float) -> None:
    job = st.job
    err = e if isinstance(e, ApiError) else api_error("internal", f"{type(e).__name__}: {e}", "See the server log.")
    job.status = "failed"
    job.error = ErrorBody(code=err.code, message=err.message, hint=err.hint)
    job.timings.total_ms = int((time.perf_counter() - t0) * 1000)
    await emit(st, "error", {"message": err.message, "code": err.code, "hint": err.hint})


async def pipeline(st: JobState, src: Path) -> None:
    global _final_asr
    job, t0 = st.job, time.perf_counter()
    try:
        # 0 convert + 1 asr
        wav = src.with_suffix(".wav")
        try:
            if settings.MOCK:
                ok, res = await stage(st, "convert", lambda: _async("mock: skipped ffmpeg"), model="mock")
                ok, res = await stage(st, "asr", mock.asr, model=_models()["asr"], preview=lambda r: r.text)
            else:
                ok, res = await stage(st, "convert", lambda: _convert(src, wav), model="ffmpeg",
                                      preview=lambda _: "16 kHz mono wav")
                if not ok:
                    return await fail(st, res, t0)
                _final_asr += 1  # live passes return busy while this runs (final ASR has priority)
                try:
                    ok, res = await stage(st, "asr", lambda: asyncio.wait_for(asr.transcribe(wav), 60),
                                          model=_models()["asr"], preview=lambda r: r.text)
                finally:
                    _final_asr -= 1
        finally:
            if not settings.KEEP_AUDIO:
                for p in (src, src.with_suffix(".wav")):
                    p.unlink(missing_ok=True)
        if not ok:
            return await fail(st, res, t0)
        job.verbatim, job.words = res.text, res.words
        job.sentences = asr.split_sentences(job.verbatim, job.words)

        # 3 decide (failure -> unavailable, never fatal). Fast path (stage mode) skips it.
        if job.fast:
            job.decisions = Decisions(available=False, recommended_mode="natural", note="Skipped (fast mode).")
            job.trace.append(TraceEntry(stage="decide", ok=True, ms=0, model="skipped (fast mode)",
                                        preview="skipped (fast mode)"))
            await emit(st, "stage", {"stage": "decide", "status": "done", "ms": 0, "preview": "skipped (fast mode)"})
            await run_ladder_watched(st, await resolve_mode(job, job.mode_requested), t0)
            return await finish(st, t0)
        ok, d = await stage(st, "decide", lambda: asyncio.wait_for(_decide(job.verbatim, job.sentences), 20),
                            model=_models()["decide"],
                            preview=lambda r: f"mode={r.recommended_mode} register={r.register}" if r.available else (r.note or "unavailable"))
        job.decisions = d if ok else Decisions(available=False, recommended_mode="natural",
                                               note=f"Decisions unavailable ({d}); using Natural mode.")
        if not settings.MOCK and settings.DECISIONS_ENABLED and settings.OPENAI_API_KEY:
            status.record("decisions", "ok" if job.decisions.available
                          else status.from_decisions_note(job.decisions.note) or "error", job.decisions.note or "")
        if not job.decisions.available:
            job.notes.append("Decisions API unavailable - default Natural mode, deterministic guard only")
            if not settings.MOCK:  # say so in the trace too: the call "succeeded" only in that it degraded cleanly
                te = job.trace[-1]
                te.ok, te.model = False, RULES_ONLY
                te.error = job.decisions.note or "Decisions unavailable"
                await _fallback(st, "decide", "Decisions offline - rule-based hints only")
        mode = await resolve_mode(job, job.mode_requested)

        await run_ladder_watched(st, mode, t0)
        await finish(st, t0)
    except Exception as e:  # noqa: BLE001
        log.exception("pipeline crashed")
        await fail(st, e, t0)


async def _convert(src: Path, wav: Path) -> None:
    await asr.convert(src, wav)


# ---------------------------------------------------------------- app
@asynccontextmanager
async def lifespan(_: FastAPI):
    (settings.cache_dir / "uploads").mkdir(parents=True, exist_ok=True)
    task = None
    if not settings.MOCK:
        status.enable_persist()
        task = asyncio.create_task(asr.load())  # warm model in the background; /api/health shows asr_loaded
    yield
    if task and not task.done():
        task.cancel()


app = FastAPI(title="VoiceFlow", lifespan=lifespan)


@app.exception_handler(ApiError)
async def _api_error(_: Request, e: ApiError):
    return JSONResponse(e.body(), status_code=e.status)


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, e: RequestValidationError):
    msg = "; ".join(f"{'.'.join(str(x) for x in err['loc'])}: {err['msg']}" for err in e.errors())
    return JSONResponse(api_error("bad_request", msg, "Check the request fields.").body(), status_code=400)


@app.exception_handler(Exception)
async def _unhandled(_: Request, e: Exception):
    log.exception("unhandled")
    return JSONResponse(api_error("internal", f"{type(e).__name__}", "See the server log.").body(), status_code=500)


_health_cache: dict[str, tuple[float, Any]] = {}


async def _cached(key: str, fn: Callable[[], Awaitable[Any]], ttl: float = 30.0):
    now = time.time()
    hit = _health_cache.get(key)
    if hit and now - hit[0] < ttl:
        return hit[1]
    val = await fn()
    _health_cache[key] = (now, val)
    return val


async def _gemma_status() -> str:
    """Never a paid call. The last real call decides no_credits / auth_error (a free metadata probe passes on a
    key with no credits); without one, a free models.get catches a bad key or no network."""
    if not settings.GEMINI_API_KEY:
        return "error"
    last = status.get("gemma")
    if last in ("no_credits", "auth_error"):
        return last
    try:
        await asyncio.wait_for(rw._get_client().aio.models.get(model=settings.GEMMA_MODEL), 5)
        return "ok"
    except Exception as e:
        acct = rw.classify(e)
        return acct.status if acct else "error"


async def _decisions_status() -> str:
    """Never a paid call: reports the outcome of the most recent real Decisions call."""
    if not settings.DECISIONS_ENABLED:
        return "off"
    if not settings.OPENAI_API_KEY:
        return "error"
    return status.get("decisions") or "ok"


@app.get("/api/health", response_model=HealthResponse)
async def health():
    if settings.MOCK:
        return HealthResponse(asr_loaded=True, decisions="ok", gemma="ok",
                              twinly=TwinlyHealth(online=True, voice_ready=True), mock=True)
    try:
        tw = await asyncio.wait_for(voice.health(), 6)
    except Exception:
        tw = TwinlyHealth()
    gemma = status.get("gemma") if status.get("gemma") in ("no_credits", "auth_error") else None
    return HealthResponse(asr_loaded=asr.loaded(), decisions=await _decisions_status(),
                          gemma=gemma or await _cached("gemma", _gemma_status), twinly=tw, mock=False)


async def _save_upload(audio: UploadFile, name: str) -> Path:
    """Stream an upload to cache/uploads with the 10 MB cap and a mime check. Caller deletes the file."""
    ctype = (audio.content_type or "").split(";")[0].strip().lower()
    if not AUDIO_MIME.match(ctype):
        raise api_error("unsupported_media", f"Unsupported file type '{ctype}'.",
                        "Send an audio recording (webm, mp4/m4a, ogg, wav or mp3).")
    dest = settings.cache_dir / "uploads" / f"{name}{Path(audio.filename or '').suffix[:8] or '.webm'}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with dest.open("wb") as f:
        while chunk := await audio.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD:
                f.close()
                dest.unlink(missing_ok=True)
                raise api_error("too_long", "Recording is larger than 10 MB.", "Record a shorter clip (max 45 s).")
            f.write(chunk)
    if size == 0:
        dest.unlink(missing_ok=True)
        raise api_error("no_speech", "The recording was empty.", "Check your microphone and try again.")
    return dest


@app.post("/api/process", status_code=202, response_model=ProcessAccepted)
async def process(audio: UploadFile = File(...), mode: str = Form("auto"), protected_terms: str = Form(""),
                  fast: bool = Form(False), session: str | None = Form(None), segment: int | None = Form(None)):
    if mode not in ("auto", *MODES):
        raise api_error("bad_request", f"Unknown mode '{mode}'.", "Use auto, minimal, natural or presenter.")
    if session is not None and not SESSION_ID.match(session):
        raise api_error("bad_request", "Bad session id.", "Use 1-64 letters, digits, '-' or '_'.")
    job_id = uuid.uuid4().hex
    dest = await _save_upload(audio, job_id)
    job = Job(id=job_id, mode_requested=mode, fast=fast, session=session, segment=segment,  # type: ignore[arg-type]
              protected_terms=[t.strip() for t in protected_terms.split(",") if t.strip()])
    st = JobState(job)
    JOBS[job_id] = st
    if session:
        _session_add(session, job_id)
    st.task = asyncio.create_task(pipeline(st, dest))
    return ProcessAccepted(job_id=job_id, session=session, segment=segment)


# ---------------------------------------------------------------- stage-mode sessions (in memory, TTL 2 h)
SESSIONS: dict[str, dict] = {}  # id -> {"jobs": [job_id], "touched": monotonic}


def _session_prune(now: float | None = None) -> None:
    now = time.monotonic() if now is None else now
    for sid in [k for k, v in SESSIONS.items() if now - v["touched"] > SESSION_TTL_S]:
        for jid in SESSIONS.pop(sid)["jobs"]:
            JOBS.pop(jid, None)  # session jobs go with their session (no audio is kept anyway)


def _session_add(sid: str, job_id: str) -> None:
    _session_prune()
    s = SESSIONS.setdefault(sid, {"jobs": [], "touched": 0.0})
    s["jobs"].append(job_id)
    s["touched"] = time.monotonic()


@app.get("/api/session/{session_id}", response_model=SessionResponse)
async def get_session(session_id: str):
    _session_prune()
    s = SESSIONS.get(session_id)
    if s is None:
        raise api_error("not_found", "Unknown session.", "The server may have restarted, or it expired after 2 h.")
    out = []
    for jid in s["jobs"]:
        if jid in JOBS:
            j = JOBS[jid].job
            out.append(SessionJob(job_id=j.id, segment=j.segment, status=j.status, rung=j.rung,
                                  rewrite=j.rewrite if j.status == "ready" else "",
                                  guard_pass=j.guard.pass_ if j.guard and j.status == "ready" else None,
                                  total_ms=j.timings.total_ms))
    # segment order; jobs without a segment keep submission order at the end
    out.sort(key=lambda x: (x.segment is None, x.segment if x.segment is not None else 0))
    return SessionResponse(session=session_id, jobs=out)


# ---------------------------------------------------------------- live draft transcript
_live_lock = asyncio.Lock()
_final_asr = 0  # final /api/process ASR passes in flight
LIVE_MAX_S = 45


def _busy(why: str) -> ApiError:
    return api_error("busy", why, "Skip this tick; the next one will catch up.")


@app.post("/api/live", response_model=LiveResponse)
async def live(audio: UploadFile = File(...), seq: int = Form(...)):
    """Rough draft transcript of the cumulative recording so far (not the verbatim of record).
    One pass at a time; final ASR has priority. The audio is never stored, whatever KEEP_AUDIO says."""
    if _live_lock.locked() or _final_asr:
        raise _busy("A transcription is already running.")
    async with _live_lock:
        t = time.perf_counter()
        if settings.MOCK:
            await asyncio.sleep(0.3)
            words = mock.asr_text().split()
            n = min(len(words), max(0, seq) * mock.LIVE_WORDS_PER_SEQ)
            return LiveResponse(seq=seq, text=" ".join(words[:n]), ms=int((time.perf_counter() - t) * 1000))
        if not asr.loaded():
            raise _busy("The speech model is still loading.")
        src = await _save_upload(audio, f"live_{uuid.uuid4().hex}")
        wav = src.with_suffix(".live.wav")
        try:
            await asr.convert(src, wav, max_seconds=LIVE_MAX_S)
            src.unlink(missing_ok=True)
            if _final_asr:  # a final pass arrived while we converted: let it have the model
                raise _busy("Final transcription in progress.")
            try:
                text = (await asr.transcribe(wav, word_timestamps=False)).text
            except ApiError as e:
                if e.code != "no_speech":
                    raise
                text = ""  # silence so far is a normal live state, not an error
        finally:
            src.unlink(missing_ok=True)
            wav.unlink(missing_ok=True)
        return LiveResponse(seq=seq, text=text, ms=int((time.perf_counter() - t) * 1000))


@app.get("/api/jobs/{job_id}", response_model=Job, response_model_by_alias=True)
async def get_job(job_id: str):
    return _state(job_id).job


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    st = _state(job_id)

    async def gen():
        idx = st.run_start
        while True:
            async with st.cond:
                try:
                    await asyncio.wait_for(st.cond.wait_for(lambda: idx < len(st.events)), 15)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                batch = st.events[idx:]
                idx = len(st.events)
            for ev, data in batch:
                yield f"event: {ev}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                if ev in ("result", "error"):
                    return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/rewrite", response_model=Job, response_model_by_alias=True)
async def rewrite_endpoint(req: RewriteRequest):
    """Re-run with another mode (reuses ASR + decisions) or guard a hand-edited rewrite against the verbatim."""
    st = _state(req.job_id)
    job = st.job
    if job.status == "failed" or not job.verbatim:
        raise api_error("bad_request", "This job has no transcript to rewrite.", "Record again.")
    if req.edited_text is None and req.mode is None:
        raise api_error("bad_request", "Send mode or edited_text.", "")
    async with st.lock:
        t0 = time.perf_counter()
        st.run_start = len(st.events)
        job.status = "running"
        if req.edited_text is not None:
            text = req.edited_text.strip()
            if not text:
                job.status = "ready"
                raise api_error("bad_request", "Edited text is empty.", "Type the text you want spoken.")
            ok, g = await stage(st, "guard", lambda: _guard(job.verbatim, text, job.mode_used or "natural",
                                                            job.protected_terms), model=_models()["guard"],
                                label="edited text",
                                preview=lambda r: ("PASS" if r.pass_ else "FAIL: " + "; ".join(v.message for v in r.violations)))
            job.rewrite, job.edits = text, rw.diff_edits(job.verbatim, text)
            if ok:
                job.guard = g  # failures are warnings; the user may override with confirm
            else:
                job.guard = None if isinstance(g, NotImplementedError) else GuardResult(**{
                    "pass": False, "verifier": "offline",
                    "violations": [Violation(rule="guard_error", message=f"Could not verify: {g}")]})
        else:
            job.mode_used = req.mode
            await run_ladder_watched(st, req.mode, t0)  # type: ignore[arg-type]
        await finish(st, t0)
    return job


@app.post("/api/speak", response_model=SpeakResponse)
async def speak(req: SpeakRequest, request: Request):
    client = await _speaker(request)  # None = global key (AUTH_ENABLED=0: unchanged behaviour)
    text = req.text.strip()
    if not text:
        raise api_error("bad_request", "Nothing to speak.", "Approve some text first.")
    if len(text) > MAX_SPEAK_CHARS:
        raise api_error("too_long", f"Text is {len(text)} characters (max {MAX_SPEAK_CHARS}).", "Shorten the announcement.")
    st = JOBS.get(req.job_id)
    t = time.perf_counter()
    try:
        if settings.MOCK:
            res = await mock.speak(text)
        elif client is not None:
            res = await asyncio.wait_for(client.speak(text), 60)
        else:
            res = await asyncio.wait_for(voice.speak(text), 60)
    except ApiError:
        raise
    except NotImplementedError:
        raise api_error("internal", "Voice output is not available yet.", "voice.py has not landed; use MOCK=1.", 501)
    except asyncio.TimeoutError:
        raise api_error("twinly_offline", "Twinly took too long to answer.", "Check the Twinly app is awake, then retry.")
    finally:
        if st:
            ok = "res" in locals()
            st.job.trace.append(TraceEntry(stage="speak", ok=ok, ms=int((time.perf_counter() - t) * 1000),
                                           model="mock" if settings.MOCK else "twinly",
                                           preview=f"{len(text)} chars" + (f" -> {len(res.chunks)} chunk(s)" if ok else ""),
                                           error=None if ok else "speak failed"))
    return res


def _check_speak_text(text: str) -> str:
    text = text.strip()
    if not text:
        raise api_error("bad_request", "Nothing to speak.", "Approve some text first.")
    if len(text) > MAX_SPEAK_CHARS:
        raise api_error("too_long", f"Text is {len(text)} characters (max {MAX_SPEAK_CHARS}).", "Shorten the announcement.")
    return text


def _renderer(client=None) -> speakq.Renderer:
    if settings.MOCK:
        return speakq.MockRenderer(mock.nap_speak, f"/api/audio/{mock.BACKUP_NAME}", mock.BACKUP_SECONDS)
    return speakq.TwinlyRenderer(client or voice._get_client())


@app.post("/api/speak/async", status_code=202, response_model=SpeakAccepted)
async def speak_async(req: SpeakRequest, request: Request):
    """Stage mode: queue the approved text and return at once; poll GET /api/speak/{speak_id}."""
    text = _check_speak_text(req.text)
    task = speakq.QUEUE.submit(req.job_id, text, _renderer(await _speaker(request)))
    return SpeakAccepted(speak_id=task.id, queue_position=speakq.QUEUE.position(task), status=task.status)


@app.get("/api/speak/{speak_id}", response_model=SpeakStatus)
async def speak_status(speak_id: str):
    task = speakq.QUEUE.get(speak_id)
    if task is None:
        raise api_error("not_found", "Unknown speak request.", "It expired (1 h) or the server restarted. Speak again.")
    return speakq.QUEUE.status(task)


# ---------------------------------------------------------------- accounts (AUTH_ENABLED=1 only)
_store: auth.ProfileStore | None = None
_user_clients: dict[str, Any] = {}  # sha256(user + key) -> voice.TwinlyClient (one per saved key)


def _profile_store() -> auth.ProfileStore:
    global _store
    if _store is None:
        if settings.PROFILE_STORE == "supabase":
            _store = auth.SupabaseStore(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_KEY)
        else:
            settings.cache_dir.mkdir(parents=True, exist_ok=True)
            _store = auth.SQLiteStore(settings.cache_dir / "profiles.sqlite")
    return _store


def _user_id(request: Request) -> str:
    h = request.headers.get("authorization", "")
    if not h.lower().startswith("bearer "):
        raise api_error("unauthorized", "Sign in first.", "Send the Supabase access token as 'Authorization: Bearer ...'.")
    return str(auth.verify_jwt(h[7:].strip(), settings.SUPABASE_JWT_SECRET)["sub"])


def _make_twinly_client(key: str):
    return voice.TwinlyClient(key, settings.TWINLY_BASE, settings.cache_dir, spend_path=settings.logs_dir / "spend.json",
                              allow_spend=os.environ.get("ALLOW_SPEND") == "1", log_dir=settings.logs_dir)


async def _client_for(user_id: str):
    p = await _profile_store().get(user_id)
    if p is None:
        raise api_error("voice_not_set_up", "No Twinly key saved for your account.", "Add your Twinly key in Settings.")
    key = auth.decrypt(p.twinly_key_encrypted, settings.ENCRYPTION_KEY, user_id)
    k = hashlib.sha256(f"{user_id}\x00{key}".encode()).hexdigest()
    if k not in _user_clients:
        _user_clients[k] = _make_twinly_client(key)  # its voice_id (cache identity) is derived from the key
    return _user_clients[k]


async def _speaker(request: Request):
    """AUTH_ENABLED=0 -> None (use the global key, unchanged). Otherwise the signed-in user's Twinly client."""
    if not settings.AUTH_ENABLED:
        return None
    uid = _user_id(request)
    return None if settings.MOCK else await _client_for(uid)


def _auth_on() -> None:
    if not settings.AUTH_ENABLED:
        raise api_error("not_found", "Accounts are disabled on this server.", "Set AUTH_ENABLED=1 to use accounts.")


async def _me_voice(uid: str) -> MeVoice:
    p = await _profile_store().get(uid)
    if p is None:
        return MeVoice(has_key=False)
    if settings.MOCK:
        return MeVoice(has_key=True, label=p.label, online=True, voice_ready=True)
    tw = await (await _client_for(uid)).health()  # GET /v1/me: free, no render
    return MeVoice(has_key=True, label=p.label, online=tw.online, voice_ready=tw.voice_ready)


@app.get("/api/me/voice", response_model=MeVoice)
async def me_voice(request: Request):
    _auth_on()
    return await _me_voice(_user_id(request))


@app.put("/api/me/voice", response_model=MeVoice)
async def put_me_voice(req: MeVoiceRequest, request: Request):
    """Save or replace the signed-in user's Twinly key (encrypted at rest). Never echoes the key."""
    _auth_on()
    uid = _user_id(request)
    enc = auth.encrypt(req.twinly_key.strip(), settings.ENCRYPTION_KEY, uid)
    await _profile_store().put(auth.Profile(uid, enc, req.label.strip()))
    return await _me_voice(uid)


@app.get("/api/audio/{name}")
async def audio_file(name: str):
    if not HASH_NAME.match(name):
        raise api_error("not_found", "No such audio.", "")
    p = settings.cache_dir / name
    if not p.exists() and name == mock.BACKUP_NAME:
        p = settings.fixtures_dir / name
    if not p.exists():
        raise api_error("not_found", "Audio not found.", "Generate it again with Speak.")
    return FileResponse(p, media_type="audio/mp4")


settings.frontend_dir.mkdir(exist_ok=True)
app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")
