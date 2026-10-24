"""/api/live, provider-status health, Gemini account errors and upload mime checks (no network)."""
import asyncio
import os

os.environ["MOCK"] = "1"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import asr, main, rewrite as rw, status, voice  # noqa: E402
from backend.config import settings  # noqa: E402
from backend.models import ASRResult, TwinlyHealth  # noqa: E402

CLIP = b"\x1aE\xdf\xa3" + b"0" * 2000  # webm magic + filler; the fakes never decode it


def _live(c, seq, data=CLIP, ctype="audio/webm;codecs=opus"):
    return c.post("/api/live", files={"audio": ("live.webm", data, ctype)}, data={"seq": str(seq)})


# ---- MOCK live ----
def test_live_mock_progressive_prefix():
    full = main.mock.asr_text().split()
    with TestClient(main.app) as c:
        texts = []
        for seq in (1, 2, 3, 50):
            r = _live(c, seq)
            assert r.status_code == 200
            body = r.json()
            assert body["seq"] == seq and body["final"] is False and body["ms"] >= 300
            texts.append(body["text"])
    assert texts[0].split() == full[:main.mock.LIVE_WORDS_PER_SEQ]
    assert all(b.startswith(a) for a, b in zip(texts, texts[1:]))
    assert texts[-1].split() == full


def test_live_busy_while_final_asr_runs(monkeypatch):
    monkeypatch.setattr(main, "_final_asr", 1)
    with TestClient(main.app) as c:
        r = _live(c, 1)
    assert r.status_code == 429 and r.json()["error"]["code"] == "busy"


def test_live_busy_when_a_pass_is_running():
    async def go():
        await main._live_lock.acquire()
        try:
            with pytest.raises(main.ApiError) as e:
                await main.live(audio=None, seq=1)  # type: ignore[arg-type]
            assert e.value.code == "busy" and e.value.status == 429
        finally:
            main._live_lock.release()
    asyncio.run(go())


def test_live_rejects_non_audio():
    with TestClient(main.app) as c:
        # MOCK short-circuits before reading the upload, so check /api/process (shared helper) for the mime rule
        r = c.post("/api/process", files={"audio": ("x.txt", b"hello", "text/plain")})
    assert r.status_code == 415 and r.json()["error"]["code"] == "unsupported_media"


# ---- real-mode live with fakes: never stores audio ----
@pytest.fixture
def real_live(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(settings, "KEEP_AUDIO", True)  # must be ignored by /api/live
    monkeypatch.setattr(asr, "loaded", lambda: True)
    monkeypatch.setattr(status, "enable_persist", lambda: None)  # lifespan runs with MOCK off: no real files,

    async def no_load():  # and no real model load
        return None
    monkeypatch.setattr(asr, "load", no_load)
    seen = {}

    async def convert(src, wav, max_seconds=None):
        seen["src"], seen["wav"], seen["cap"] = src, wav, max_seconds
        wav.write_bytes(b"RIFF")

    async def transcribe(wav, word_timestamps=True):
        seen["words"] = word_timestamps
        return ASRResult(text="so um the meeting is on")
    monkeypatch.setattr(asr, "convert", convert)
    monkeypatch.setattr(asr, "transcribe", transcribe)
    return seen


def test_live_real_path_deletes_audio(real_live):
    with TestClient(main.app) as c:
        r = _live(c, 4)
    assert r.status_code == 200 and r.json()["text"] == "so um the meeting is on"
    assert real_live["cap"] == main.LIVE_MAX_S and real_live["words"] is False
    assert not real_live["src"].exists() and not real_live["wav"].exists()


def test_live_real_silence_is_empty_text(real_live, monkeypatch):
    async def silent(wav, word_timestamps=True):
        raise main.api_error("no_speech", "Couldn't hear anything.")
    monkeypatch.setattr(asr, "transcribe", silent)
    with TestClient(main.app) as c:
        r = _live(c, 1)
    assert r.status_code == 200 and r.json()["text"] == ""


def test_live_real_size_cap(real_live):
    with TestClient(main.app) as c:
        r = _live(c, 1, data=b"0" * (10 * 1024 * 1024 + 1))
    assert r.status_code == 413 and r.json()["error"]["code"] == "too_long"


def test_live_real_model_loading_is_busy(real_live, monkeypatch):
    monkeypatch.setattr(asr, "loaded", lambda: False)
    with TestClient(main.app) as c:
        r = _live(c, 1)
    assert r.status_code == 429 and "loading" in r.json()["error"]["message"]


# ---- Gemini account errors ----
class _ClientError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


@pytest.mark.parametrize("code,msg,want", [
    (402, "402 RESOURCE_EXHAUSTED. Your prepayment credits are depleted.", "no_credits"),
    (401, "401 UNAUTHENTICATED. ACCESS_TOKEN_TYPE_UNSUPPORTED", "auth_error"),
    (403, "403 PERMISSION_DENIED.", "auth_error"),
    (429, "429 RESOURCE_EXHAUSTED. Quota exceeded.", None),
    (500, "500 INTERNAL.", None),
])
def test_classify(code, msg, want):
    got = rw.classify(_ClientError(code, msg))
    assert (got.status if got else None) == want


def test_402_is_not_retried(monkeypatch):
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test")
    monkeypatch.setattr(status, "_persist", False)
    monkeypatch.setattr(status, "_last", {})
    calls = []

    async def gen(prompt, model):
        calls.append(model)
        raise _ClientError(402, "402 RESOURCE_EXHAUSTED. Your prepayment credits are depleted.")
    monkeypatch.setattr(rw, "_generate", gen)
    with pytest.raises(rw.GemmaUnavailable) as e:
        asyncio.run(rw.run("so um hi", "natural"))
    assert len(calls) == 1 and "no credits" in str(e.value)
    assert status.get("gemma") == "no_credits"


# ---- health ----
@pytest.fixture
def real_health(monkeypatch):
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test")
    monkeypatch.setattr(settings, "OPENAI_API_KEY", "test")
    monkeypatch.setattr(settings, "DECISIONS_ENABLED", True)
    monkeypatch.setattr(main, "_health_cache", {})
    monkeypatch.setattr(status, "_last", {})
    monkeypatch.setattr(status, "_persist", False)

    async def tw():
        return TwinlyHealth(online=True, voice_ready=True)
    monkeypatch.setattr(voice, "health", tw)

    async def get(**kw):
        return object()  # free metadata probe succeeds (as it does on a key with no credits)

    class _Models:
        def __init__(self):
            self.get = get

    class _Aio:
        models = _Models()

    class _Client:
        aio = _Aio()
    monkeypatch.setattr(rw, "_get_client", lambda: _Client())


def _health():
    return asyncio.run(main.health())


def test_health_reports_last_real_call(real_health):
    h = _health()
    assert h.gemma == "ok" and h.decisions == "ok"
    status.record("gemma", "no_credits", "402")
    status.record("decisions", status.from_decisions_note(
        "Decisions API unavailable (429 credit_balance_exhausted). Defaulting to Natural."))
    h = _health()
    assert h.gemma == "no_credits" and h.decisions == "no_credits"
    status.record("gemma", "auth_error")
    assert _health().gemma == "auth_error"


@pytest.mark.parametrize("note,want", [
    ("Decisions API unavailable (429 credit_balance_exhausted). Defaulting", "no_credits"),
    ("Decisions API unavailable (429 insufficient_quota). Defaulting", "no_credits"),
    ("Decisions API unavailable (401 invalid_api_key). Defaulting", "auth_error"),
    ("Decisions API unavailable (timed out after 8 s). Defaulting", None),
    (None, None),
])
def test_decisions_note_classification(note, want):
    assert status.from_decisions_note(note) == want


@pytest.mark.parametrize("ctype,ok", [
    ("audio/webm;codecs=opus", True), ("audio/mp4", True), ("audio/x-m4a", True), ("video/webm", True),
    ("application/octet-stream", True), ("", True), ("text/plain", False), ("image/png", False),
    ("application/json", False),
])
def test_audio_mime_rule(ctype, ok):
    assert bool(main.AUDIO_MIME.match(ctype.split(";")[0])) is ok
