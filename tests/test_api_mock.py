"""Contract smoke test against the MOCK=1 server (no network)."""
import json
import os

os.environ["MOCK"] = "1"

from fastapi.testclient import TestClient  # noqa: E402

from backend.config import settings  # noqa: E402
from backend.main import app  # noqa: E402

AUDIO = settings.fixtures_dir / "backup_demo.m4a"


def _process(c, mode="auto"):
    r = c.post("/api/process", files={"audio": ("a.m4a", AUDIO.read_bytes(), "audio/mp4")}, data={"mode": mode})
    assert r.status_code == 202
    return r.json()["job_id"]


def test_full_flow():
    with TestClient(app) as c:
        jid = _process(c)
        events = []
        with c.stream("GET", f"/api/jobs/{jid}/events") as r:
            ev = None
            for line in r.iter_lines():
                if line.startswith("event:"):
                    ev = line.split(": ", 1)[1]
                elif line.startswith("data:"):
                    events.append((ev, json.loads(line[6:])))
        assert events[-1][0] == "result"
        stages = [d["stage"] for e, d in events if e == "stage" and d["status"] == "done"]
        assert stages == ["convert", "asr", "decide", "rewrite", "guard"]
        job = c.get(f"/api/jobs/{jid}").json()
        assert job["status"] == "ready" and job["rung"] == "full" and job["mode_used"] == "presenter"
        assert "Monday" in job["rewrite"] and "Friday" not in job["rewrite"]
        assert job["guard"]["pass"] is True and job["edits"][0]["from"]
        assert [t["stage"] for t in job["trace"]] == ["convert", "asr", "decide", "rewrite", "guard"]

        # bad hand-edit is flagged, not spoken automatically
        bad = c.post("/api/rewrite", json={"job_id": jid, "edited_text": "Meeting is Friday at 5 PM"}).json()
        assert bad["guard"]["pass"] is False and bad["guard"]["violations"]

        again = c.post("/api/rewrite", json={"job_id": jid, "mode": "minimal"}).json()
        assert again["mode_used"] == "minimal" and again["rung"] == "full"

        s = c.post("/api/speak", json={"job_id": jid, "text": "Hello"}).json()
        assert s["chunks"][0]["url"].endswith(".m4a")
        a = c.get(s["chunks"][0]["url"])
        assert a.status_code == 200 and a.headers["content-type"] == "audio/mp4"


def test_errors():
    with TestClient(app) as c:
        e = c.post("/api/speak", json={"job_id": "x", "text": ""})
        assert e.status_code == 400 and e.json()["error"]["code"] == "bad_request"
        e = c.post("/api/speak", json={"job_id": "x", "text": "a" * 2401})
        assert e.status_code == 413 and e.json()["error"]["code"] == "too_long"
        assert c.get("/api/jobs/nope").json()["error"]["code"] == "not_found"
        e = c.post("/api/process", files={"audio": ("a.webm", b"0" * (10 * 1024 * 1024 + 1), "audio/webm")})
        assert e.status_code == 413
        assert c.get("/api/health").json()["mock"] is True
