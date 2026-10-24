"""Stage mode backend: async speak queue, fast=1 path, sessions, honest trace labels. No network."""
import asyncio
import os
import time

os.environ["MOCK"] = "1"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import asr, decide, guard, main, rewrite as rw, speakq, status  # noqa: E402
from backend.config import settings  # noqa: E402
from backend.errors import api_error  # noqa: E402
from backend.models import ASRResult, AudioChunk, Decisions, Job  # noqa: E402

LONG = " ".join(["This sentence is here to fill up the first chunk of a long announcement."] * 8)  # 2 chunks


class FakeVoice:
    """Renders take `delay` s; texts in `fail` raise; texts in `cache` are cache hits."""

    def __init__(self, delay=0.05, fail=(), cache=()):
        self.delay, self.fail, self.cache = delay, set(fail), set(cache)
        self.rendered: list[str] = []
        self.active = self.max_active = 0

    async def render(self, text):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(self.delay)
            if text in self.fail:
                raise api_error("internal", "Twinly failed to render the voice.", "Retry once.")
            self.rendered.append(text)
            return AudioChunk(url=f"/api/audio/{len(self.rendered)}.m4a", seconds=1.0)
        finally:
            self.active -= 1

    def cached(self, text):
        return AudioChunk(url="/api/audio/hit.m4a", seconds=1.0, cached=True) if text in self.cache else None


async def _until(pred, timeout=3.0):
    t = time.monotonic()
    while not pred():
        assert time.monotonic() - t < timeout, "timed out"
        await asyncio.sleep(0.005)


# ---------------------------------------------------------------- queue
def test_fifo_order_serialised_and_queue_position():
    async def go():
        q, v = speakq.SpeakQueue(), FakeVoice(delay=0.05)
        a = q.submit("j", "First segment.", v)
        b = q.submit("j", "Second segment.", v)
        c = q.submit("j", "Third segment.", v)
        await asyncio.sleep(0)
        assert q.position(a) == 0 and q.position(b) == 1 and q.position(c) == 2
        assert q.status(b).status == "queued"
        await _until(lambda: c.status == "done")
        assert v.rendered == ["First segment.", "Second segment.", "Third segment."]
        assert v.max_active == 1  # never two renders at once (Twinly's engine crashes)
        assert q.position(c) == 0 and a.finished <= b.finished <= c.finished
    asyncio.run(go())


def test_chunks_are_published_in_order_as_they_land():
    async def go():
        q, v = speakq.SpeakQueue(), FakeVoice(delay=0.1)
        t = q.submit("j", LONG, v)
        assert len(t.texts) == 2
        await _until(lambda: len(t.chunks) == 1)
        s = q.status(t)
        assert s.status == "rendering" and s.total_chunks == 2 and len(s.chunks) == 1
        await _until(lambda: t.status == "done")
        assert [c.url for c in t.chunks] == ["/api/audio/1.m4a", "/api/audio/2.m4a"]
    asyncio.run(go())


def test_cache_hit_skips_the_queue():
    async def go():
        q, v = speakq.SpeakQueue(), FakeVoice(delay=0.5, cache={"Cached line."})
        busy = q.submit("j", "Slow line.", v)
        hit = q.submit("j", "Cached line.", v)
        assert hit.status == "done" and hit.chunks[0].cached and q.position(hit) == 0
        assert busy.status in ("queued", "rendering") and v.rendered == []
    asyncio.run(go())


def test_failure_midway_keeps_first_chunk_and_queue_survives():
    async def go():
        q = speakq.SpeakQueue()
        second = speakq.split.pack(LONG, speakq.CHUNK_CHARS)[1]
        v = FakeVoice(fail={second})
        t = q.submit("j", LONG, v)
        after = q.submit("j", "Next segment.", v)
        await _until(lambda: after.status == "done")
        s = q.status(t)
        assert s.status == "failed" and len(s.chunks) == 1 and s.chunks[0].url == "/api/audio/1.m4a"
        assert s.error.code == "internal" and "Twinly" in s.error.message
    asyncio.run(go())


def test_ttl_cleanup():
    async def go():
        now = [1000.0]
        q, v = speakq.SpeakQueue(clock=lambda: now[0], ttl_s=3600), FakeVoice(cache={"Hit."})
        t = q.submit("j", "Hit.", v)
        now[0] += 3599
        assert q.get(t.id) is t
        now[0] += 2
        assert q.get(t.id) is None
    asyncio.run(go())


def test_async_speak_endpoint_mock():
    with TestClient(main.app) as c:
        r = c.post("/api/speak/async", json={"job_id": "x", "text": "Our meeting is on Monday."})
        assert r.status_code == 202
        sid = r.json()["speak_id"]
        for _ in range(100):
            s = c.get(f"/api/speak/{sid}").json()
            if s["status"] in ("done", "failed"):
                break
            time.sleep(0.05)
        assert s["status"] == "done" and s["synthetic"] is True
        assert s["chunks"][0]["url"] == "/api/audio/backup_demo.m4a" and s["chunks"][0]["seconds"] == 3.84
        assert c.get(s["chunks"][0]["url"]).headers["content-type"] == "audio/mp4"
        assert c.post("/api/speak/async", json={"job_id": "x", "text": " "}).status_code == 400
        assert c.post("/api/speak/async", json={"job_id": "x", "text": "a" * 2401}).status_code == 413
        assert c.get("/api/speak/nope").json()["error"]["code"] == "not_found"
        # the blocking endpoint is unchanged
        b = c.post("/api/speak", json={"job_id": "x", "text": "Hello"}).json()
        assert b["chunks"][0]["seconds"] == 3.84


# ---------------------------------------------------------------- sessions
def test_session_lists_jobs_in_segment_order():
    audio = settings.fixtures_dir / "backup_demo.m4a"
    with TestClient(main.app) as c:
        ids = {}
        for seg in (2, 0, 1):
            r = c.post("/api/process", files={"audio": ("a.m4a", audio.read_bytes(), "audio/mp4")},
                       data={"session": "stage-1", "segment": str(seg), "fast": "1"})
            assert r.status_code == 202 and r.json()["session"] == "stage-1" and r.json()["segment"] == seg
            ids[seg] = r.json()["job_id"]
        for _ in range(100):
            s = c.get("/api/session/stage-1").json()
            if all(j["status"] == "ready" for j in s["jobs"]):
                break
            time.sleep(0.05)
        assert [j["segment"] for j in s["jobs"]] == [0, 1, 2]
        assert [j["job_id"] for j in s["jobs"]] == [ids[0], ids[1], ids[2]]
        assert all(j["rewrite"] and j["guard_pass"] is not None for j in s["jobs"])
        job = c.get(f"/api/jobs/{ids[1]}").json()
        assert job["session"] == "stage-1" and job["segment"] == 1 and job["fast"] is True
        assert c.post("/api/process", files={"audio": ("a.m4a", b"x", "audio/mp4")},
                      data={"session": "bad id!"}).status_code == 400
        main._session_prune(now=time.monotonic() + main.SESSION_TTL_S + 1)
        assert c.get("/api/session/stage-1").status_code == 404
        assert ids[1] not in main.JOBS


# ---------------------------------------------------------------- fast path + honest labels (real mode, fakes)
@pytest.fixture
def real(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test")
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "test")
    monkeypatch.setattr(settings, "DECISIONS_ENABLED", True)
    monkeypatch.setattr(status, "_last", {})
    monkeypatch.setattr(status, "_persist", False)
    monkeypatch.setattr(main, "FAST_GEMMA_S", 0.3)
    monkeypatch.setattr(settings, "GEMMA_TIMEOUT_S", 0.3)

    async def convert(src, wav, max_seconds=None):
        wav.write_bytes(b"RIFF")

    async def transcribe(wav, word_timestamps=True):
        return ASRResult(text="So um the meeting is on Friday, no wait, Monday at 5 PM.")
    monkeypatch.setattr(asr, "convert", convert)
    monkeypatch.setattr(asr, "transcribe", transcribe)
    calls = {"gemma": 0, "decide": 0, "verify": 0}

    async def hang(prompt, model):
        calls["gemma"] += 1
        await asyncio.sleep(30)
    monkeypatch.setattr(rw, "_generate", hang)

    async def analyze(verbatim, sentences):
        calls["decide"] += 1
        return Decisions(available=False, note="Decisions API unavailable (429 credit_balance_exhausted).")
    monkeypatch.setattr(decide, "analyze", analyze)

    async def verify(o, r):
        calls["verify"] += 1
        return decide.Verification(False, note="offline")
    monkeypatch.setattr(decide, "verify", verify)
    src = tmp_path / "a.webm"
    return calls, src


def _pipeline(src, fast):
    src.write_bytes(b"x")
    st = main.JobState(Job(id="t", fast=fast))
    t = time.perf_counter()
    asyncio.run(main.pipeline(st, src))
    return st.job, time.perf_counter() - t


def test_fast_path_skips_decisions_retry_and_verifier(real):
    calls, src = real
    job, secs = _pipeline(src, fast=True)
    assert job.status == "ready" and job.rung == "minimal" and job.guard.pass_
    assert job.rewrite == "So the meeting is on Monday at 5 PM."
    assert calls["decide"] == 0 and calls["verify"] == 0 and calls["gemma"] == 1
    assert secs < 1.5  # Gemma capped at FAST_GEMMA_S, no stricter retry
    labels = [(t.stage, t.model) for t in job.trace]
    assert ("decide", "skipped (fast mode)") in labels and ("guard", "rules only (fast mode)") in labels
    assert not any("retry" in (t.preview or "") for t in job.trace)


def test_fast_path_skips_gemma_after_a_recent_402(real):
    calls, src = real
    status.record("gemma", "no_credits", "402")
    job, _ = _pipeline(src, fast=True)
    assert calls["gemma"] == 0 and job.rung == "minimal"
    assert any(t.stage == "rewrite" and t.error and "no_credits" in t.error for t in job.trace)


def test_without_fast_nothing_changes_and_trace_is_honest(real):
    calls, src = real
    job, _ = _pipeline(src, fast=False)
    assert calls["decide"] == 1 and calls["verify"] >= 1 and calls["gemma"] >= 1
    d = next(t for t in job.trace if t.stage == "decide")
    assert d.ok is False and d.model == main.RULES_ONLY and "credit_balance_exhausted" in d.error
    g = [t for t in job.trace if t.stage == "guard"][-1]
    assert g.model == main.RULES_ONLY
    assert job.rung == "minimal" and job.guard.pass_
