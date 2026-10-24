"""Settings switch: decisions=0 on /api/process skips the Decisions call and keeps the rules-only guard."""
import time

import pytest
from fastapi.testclient import TestClient

from backend import main
from backend.config import settings


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "MOCK", True)
    called = []

    async def spy(verbatim, sentences):
        called.append(verbatim)
        return await main.mock.decide()
    monkeypatch.setattr(main, "_decide", spy)
    with TestClient(main.app) as c:
        yield c, called


def _run(c, **form):
    r = c.post("/api/process", files={"audio": ("a.webm", b"x" * 900, "audio/webm")}, data=form)
    assert r.status_code == 202
    jid = r.json()["job_id"]
    for _ in range(100):
        job = c.get(f"/api/jobs/{jid}").json()
        if job["status"] != "running":
            return job
        time.sleep(0.05)
    raise AssertionError("job never finished")


def test_decisions_off_skips_the_call(client):
    c, called = client
    job = _run(c, decisions="0")
    assert job["status"] == "ready" and not called
    assert job["use_decisions"] is False
    decide = next(t for t in job["trace"] if t["stage"] == "decide")
    assert "turned off in Settings" in decide["model"]
    assert job["decisions"]["available"] is False


def test_decisions_on_by_default(client):
    c, called = client
    job = _run(c)
    assert job["status"] == "ready" and called and job["use_decisions"] is True
