"""FastAPI app + orchestrator (docs/md/02, 03, 10).

Job store is in-memory. Every stage appends a TraceEntry and pushes an SSE event. A stage failure never
kills the job: it takes the next fallback rung (retry stricter -> minimal -> original). Only ASR failure
or an empty transcript is fatal.
"""
import asyncio
import json
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

from . import asr, decide, guard, mock, rewrite as rw, voice
from .config import settings
from .errors import ApiError, api_error
from .models import (
    Decisions, ErrorBody, GuardResult, HealthResponse, Job, Mode, ProcessAccepted, RewriteRequest,
    SpeakRequest, SpeakResponse, TraceEntry, TwinlyHealth, Violation,
)

log = logging.getLogger("voiceflow")
logging.basicConfig(level=logging.INFO)

MAX_UPLOAD = 10 * 1024 * 1024
MAX_SPEAK_CHARS = 2400
MODES = ("minimal", "natural", "presenter")
HASH_NAME = re.compile(r"^(?:[0-9a-f]{64}|backup_demo)\.m4a$")


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
        if not isinstance(e, (ApiError, NotImplementedError)):
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


async def _guard(verbatim: str, rewrite_text: str) -> GuardResult:
    if settings.MOCK:
        return await mock.guard(verbatim, rewrite_text)
    return await guard.check(verbatim, rewrite_text)


async def _rewrite(verbatim: str, mode: Mode, decisions: Decisions | None, violations: list[str] | None):
    if settings.MOCK:
        return await mock.rewrite(mode), "mock"
    return await rw.run(verbatim, mode, decisions, violations)


# ---------------------------------------------------------------- rewrite + guard with the fallback ladder
async def run_ladder(st: JobState, mode: Mode) -> None:
    """full -> retry (stricter, lists violated facts) -> minimal (deterministic) -> original. Always terminates."""
    job = st.job
    job.mode_used = mode
    job.notes = [n for n in job.notes if not n.startswith("ladder:")]
    violations: list[str] | None = None
    guard_unavailable = False
    api_down = False  # rewrite call itself failed (auth/network): a stricter retry cannot help

    async def attempt(rung: str, label: str) -> bool:
        nonlocal violations, guard_unavailable, api_down
        ok, res = await stage(st, "rewrite", lambda: _rewrite(job.verbatim, mode, job.decisions, violations),
                              model=_models()["rewrite"], label=label, preview=lambda r: r[0].rewrite)
        if not ok:
            api_down = not isinstance(res, ValueError)  # ValueError covers bad JSON / sanity rejects
            violations = [f"previous attempt failed: {res}"] if rung == "full" else violations
            return False
        result, model_used = res
        job.rewrite, job.edits = result.rewrite, result.edits
        return await check(rung)

    async def check(rung: str) -> bool:
        nonlocal violations, guard_unavailable
        ok, g = await stage(st, "guard", lambda: _guard(job.verbatim, job.rewrite), model=_models()["guard"],
                            preview=lambda r: ("PASS" if r.pass_ else "FAIL: " + "; ".join(v.message for v in r.violations))
                            + f" (verifier {r.verifier})")
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
        if g.verifier == "offline":
            note = "AI verifier offline - deterministic checks only"
            if note not in job.notes:
                job.notes.append(note)
        if g.pass_:
            job.rung = rung  # type: ignore[assignment]
            return True
        violations = [v.message for v in g.violations] or ["meaning changed"]
        return False

    if await attempt("full", ""):
        return
    if not api_down:
        await _fallback(st, "rewrite", "Rewrite rejected - retrying with a stricter prompt")
        if await attempt("retry", "retry (stricter)"):
            return

    await _fallback(st, "rewrite", "Falling back to minimal filler removal (no AI)")
    ok, res = await stage(st, "rewrite", lambda: _async(rw.minimal(job.verbatim)), model="deterministic",
                          label="minimal", preview=lambda r: r.rewrite)
    if ok:
        job.rewrite, job.edits = res.rewrite, res.edits
        if res.rewrite.strip() and await check("minimal"):
            return

    await _fallback(st, "rewrite", "Using the original transcript - no changes made")
    job.rewrite, job.edits, job.rung = job.verbatim, [], "original"
    job.guard = GuardResult(**{"pass": True, "verifier": "offline"})
    job.notes.append("ladder: no changes made")


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
                ok, res = await stage(st, "asr", lambda: asr.transcribe(wav), model=_models()["asr"],
                                      preview=lambda r: r.text)
        finally:
            if not settings.KEEP_AUDIO:
                for p in (src, src.with_suffix(".wav")):
                    p.unlink(missing_ok=True)
        if not ok:
            return await fail(st, res, t0)
        job.verbatim, job.words = res.text, res.words
        job.sentences = asr.split_sentences(job.verbatim, job.words)

        # 3 decide (failure -> unavailable, never fatal)
        ok, d = await stage(st, "decide", lambda: _decide(job.verbatim, job.sentences), model=_models()["decide"],
                            preview=lambda r: f"mode={r.recommended_mode} register={r.register}" if r.available else (r.note or "unavailable"))
        job.decisions = d if ok else Decisions(available=False, recommended_mode="natural",
                                               note=f"Decisions unavailable ({d}); using Natural mode.")
        if not job.decisions.available:
            job.notes.append("Decisions API unavailable - default Natural mode, deterministic guard only")
        mode = await resolve_mode(job, job.mode_requested)

        await run_ladder(st, mode)
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
    if not settings.GEMINI_API_KEY:
        return "error"
    try:
        await asyncio.wait_for(rw._get_client().aio.models.get(model=settings.GEMMA_MODEL), 5)
        return "ok"
    except Exception:
        return "error"


async def _decisions_status() -> str:
    if not settings.DECISIONS_ENABLED:
        return "off"
    return "ok" if settings.OPENAI_API_KEY else "error"


@app.get("/api/health", response_model=HealthResponse)
async def health():
    if settings.MOCK:
        return HealthResponse(asr_loaded=True, decisions="ok", gemma="ok",
                              twinly=TwinlyHealth(online=True, voice_ready=True), mock=True)
    try:
        tw = await asyncio.wait_for(voice.health(), 6)
    except Exception:
        tw = TwinlyHealth()
    return HealthResponse(asr_loaded=asr.loaded(), decisions=await _decisions_status(),
                          gemma=await _cached("gemma", _gemma_status), twinly=tw, mock=False)


@app.post("/api/process", status_code=202, response_model=ProcessAccepted)
async def process(audio: UploadFile = File(...), mode: str = Form("auto"), protected_terms: str = Form("")):
    if mode not in ("auto", *MODES):
        raise api_error("bad_request", f"Unknown mode '{mode}'.", "Use auto, minimal, natural or presenter.")
    job_id = uuid.uuid4().hex
    dest = settings.cache_dir / "uploads" / f"{job_id}{Path(audio.filename or '').suffix[:8] or '.webm'}"
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
    job = Job(id=job_id, mode_requested=mode,  # type: ignore[arg-type]
              protected_terms=[t.strip() for t in protected_terms.split(",") if t.strip()])
    st = JobState(job)
    JOBS[job_id] = st
    st.task = asyncio.create_task(pipeline(st, dest))
    return ProcessAccepted(job_id=job_id)


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
            ok, g = await stage(st, "guard", lambda: _guard(job.verbatim, text), model=_models()["guard"],
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
            await run_ladder(st, req.mode)  # type: ignore[arg-type]
        await finish(st, t0)
    return job


@app.post("/api/speak", response_model=SpeakResponse)
async def speak(req: SpeakRequest):
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
