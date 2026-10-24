"""POST /api/stage/segment contract. MOCK=1, no network, no Twinly speak.

Xfail only while the route is missing. With it registered, these run for real.
"""
import os
import uuid

os.environ["MOCK"] = "1"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend import main, rewrite as rw  # noqa: E402
from backend.config import settings  # noqa: E402
from backend.models import RewriteResult  # noqa: E402
from backend.speakq import QUEUE  # noqa: E402

AUDIO = settings.fixtures_dir / "backup_demo.m4a"
FIELDS = ("job_id", "segment", "verbatim", "rewrite", "guard", "speak_id", "held", "timings")
TIMING_KEYS = ("asr_ms", "rewrite_ms", "guard_ms", "total_ms")
FRIDAY = "Our meeting is on Friday at 5 PM."

_LANDED = any(getattr(r, "path", None) == "/api/stage/segment" for r in main.app.routes)
if not _LANDED:
    pytestmark = pytest.mark.xfail(
        reason="POST /api/stage/segment is not registered yet", strict=False)


@pytest.fixture(autouse=True)
def _force_mock():
    settings.MOCK = True
    yield


def _post(c, *, session, segment, consent="1", audio=None, mime="audio/mp4", filename="a.m4a", terms=""):
    body = audio if audio is not None else AUDIO.read_bytes()
    return c.post(
        "/api/stage/segment",
        files={"audio": (filename, body, mime)},
        data={"session": session, "segment": str(segment), "protected_terms": terms, "consent": consent},
    )


def _sid():
    return "seg-" + uuid.uuid4().hex[:12]


def test_happy_path_returns_fields_and_speak_id():
    with TestClient(main.app) as c:
        before = set(QUEUE.tasks)
        r = _post(c, session=_sid(), segment=0, consent="1")
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(FIELDS) <= set(body)
        assert isinstance(body["job_id"], str) and body["job_id"]
        assert body["segment"] == 0
        assert body["verbatim"] and body["rewrite"]
        assert body["guard"]["pass"] is True
        assert body["guard"]["violations"] == []
        assert body["held"] is False
        assert isinstance(body["speak_id"], str) and body["speak_id"]
        assert body["speak_id"] not in before
        for _ in range(40):
            s = c.get(f"/api/speak/{body['speak_id']}")
            if s.status_code == 200:
                break
        assert s.status_code == 200
        assert s.json()["status"] in ("queued", "rendering", "done")


def test_guard_fail_is_held_and_not_spoken(monkeypatch):
    """Segment 2's verbatim is "Friday, actually, sorry, Saturday". A rewrite that still says Friday
    is the case mock.guard blocks, and the real rules block too."""
    def friday(*_a, **_k):
        return RewriteResult(rewrite=FRIDAY, edits=[])

    monkeypatch.setattr(rw, "minimal", friday)
    with TestClient(main.app) as c:
        r = _post(c, session=_sid(), segment=2, consent="1")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["guard"]["pass"] is False
        assert body["guard"]["violations"]
        assert body["held"] is True
        assert body["speak_id"] is None


def test_consent_zero_never_enqueues():
    with TestClient(main.app) as c:
        before = set(QUEUE.tasks)
        r = _post(c, session=_sid(), segment=0, consent="0")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["speak_id"] is None
        assert set(QUEUE.tasks) == before


def test_session_segments_keep_order():
    session = _sid()
    with TestClient(main.app) as c:
        ids = {}
        for seg in (2, 0, 1):
            r = _post(c, session=session, segment=seg, consent="0")
            assert r.status_code == 200, r.text
            assert r.json()["segment"] == seg
            ids[seg] = r.json()["job_id"]
        listed = c.get(f"/api/session/{session}")
        assert listed.status_code == 200, listed.text
        jobs = listed.json()["jobs"]
        assert [j["segment"] for j in jobs] == [0, 1, 2]
        assert [j["job_id"] for j in jobs] == [ids[0], ids[1], ids[2]]


def test_bad_mime_415_and_empty_audio_422():
    with TestClient(main.app) as c:
        session = _sid()
        bad = _post(c, session=session, segment=0, audio=b"not-audio", mime="text/plain", filename="a.txt")
        assert bad.status_code == 415
        assert bad.json()["error"]["code"] == "unsupported_media"
        empty = _post(c, session=session, segment=1, audio=b"", mime="audio/webm", filename="a.webm")
        assert empty.status_code == 422
        assert empty.json()["error"]["code"] == "no_speech"


def test_timings_present_and_non_negative():
    with TestClient(main.app) as c:
        r = _post(c, session=_sid(), segment=3, consent="0")
        assert r.status_code == 200, r.text
        timings = r.json()["timings"]
        assert set(TIMING_KEYS) <= set(timings)
        for key in TIMING_KEYS:
            assert isinstance(timings[key], (int, float)) and timings[key] >= 0
