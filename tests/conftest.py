import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


import pytest

@pytest.fixture
def approved_speech():
    from backend import main
    from backend.models import Job, GuardResult
    def make(text="Hello", job_id="j"):
        main.JOBS[job_id] = main.JobState(Job(id=job_id, status="ready", verbatim=text, rewrite=text,
            guard=GuardResult(**{"pass": True})))
        return {"job_id": job_id, "text": text, "revision": 0, "approved": True}
    return make

@pytest.fixture(autouse=True)
def no_paid_http(monkeypatch):
    import httpx
    send = httpx.AsyncClient.send
    async def guarded(client, *args, **kwargs):
        if not isinstance(client._transport, (httpx.MockTransport, httpx.ASGITransport)):
            raise AssertionError("Tests must not make real provider requests")
        return await send(client, *args, **kwargs)
    monkeypatch.setattr(httpx.AsyncClient, "send", guarded)
