"""Test-only stand-in for the VoiceFlow backend that misbehaves on purpose (hangs, stalls, fallbacks, speak errors).

Serves ../ (the frontend) and fakes /api/* per docs/md/10. Pick a scenario with
POST /__scenario {"name": "...", "health": {...}?, "live": "ok|busy|404"?}; each new job snapshots the current scenario.
Not used by the app; run from the repo root:  .venv/bin/python frontend/e2e/scenario_server.py --port 8002
"""
import argparse
import asyncio
import json
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

FRONTEND = Path(__file__).resolve().parent.parent
VERBATIM = "So um my name is Ariane Patel and the team meeting is on uh Friday, no wait, Monday at five p m."
REWRITE = "My name is Ariane Patel, and the team meeting is on Monday at five p m."
MINIMAL = "So my name is Ariane Patel and the team meeting is on Friday, no wait, Monday at five p m."

app = FastAPI()
HEALTH_OK = {"asr_loaded": True, "decisions": "ok", "gemma": "ok", "twinly": {"online": True, "voice_ready": True}, "mock": False}
state = {"scenario": "ok", "health": HEALTH_OK, "live": "ok", "live_calls": [], "live_inflight": 0, "live_max": 0}
speaks: dict[str, dict] = {}
jobs: dict[str, dict] = {}


def tr(stage, ok=True, ms=100, model="scenario", preview="", error=None):
    return {"stage": stage, "ok": ok, "ms": ms, "model": model, "preview": preview, "error": error}


def guard(ok=True):
    return {"pass": ok, "violations": [], "decisions_probs": {"meaning_preserved": 0.95 if ok else 0.2}, "verifier": "offline"}


def base_job(jid, terms):
    return {"id": jid, "status": "running", "mode_used": "natural", "rung": "full", "verbatim": "", "sentences": [],
            "decisions": None, "rewrite": "", "edits": [], "guard": None, "trace": [], "timings": {"total_ms": 0},
            "protected_terms": terms, "notes": [], "error": None}


# Per scenario: SSE events to send, the final job (None = never finishes), and the snapshot GET /api/jobs returns.
def build(name, jid, terms):
    j = base_job(jid, terms)
    head = [tr("convert", ms=120, model="ffmpeg"), tr("asr", ms=2100, model="crisperwhisper-turbo", preview=VERBATIM[:40])]
    ev = [("stage", {"stage": "convert", "status": "start"}), ("stage", {"stage": "convert", "status": "done", "ms": 120}),
          ("stage", {"stage": "asr", "status": "start"}), ("stage", {"stage": "asr", "status": "done", "ms": 2100})]
    if name == "hang-asr":
        j["trace"] = head[:1]
        return ev[:3], None, j
    j["verbatim"] = VERBATIM
    j["trace"] = head + [tr("decide", ms=900, model="gpt-6-luna")]
    ev += [("stage", {"stage": "decide", "status": "start"}), ("stage", {"stage": "decide", "status": "done", "ms": 900})]
    if name in ("hang-edit", "stall-poll"):
        return ev + [("stage", {"stage": "rewrite", "status": "start"})], None, j
    done = dict(j, status="ready", timings={"total_ms": 9000})
    if name == "fallback-minimal":
        done.update(rung="minimal", rewrite=MINIMAL, guard=guard(), edits=[{"from": "um", "to": "", "reason": "filler"}],
                    notes=["Decisions API unavailable - default Natural mode, deterministic guard only", "AI verifier offline - deterministic checks only"],
                    trace=head + [tr("decide", False, 400, "gpt-6-luna", error="RateLimitError: Error code: 429 - insufficient_quota"),
                                  tr("rewrite", False, 16000, "gemma-4-26b-a4b-it", error="ServerError: 500 INTERNAL. An internal error has occurred."),
                                  tr("rewrite", True, 3, "deterministic", preview=MINIMAL), tr("guard", True, 40, "deterministic+decisions", preview="PASS (verifier offline)")])
        ev += [("stage", {"stage": "rewrite", "status": "start"}), ("stage", {"stage": "rewrite", "status": "error", "ms": 16000, "preview": "ServerError: 500 INTERNAL"}),
               ("stage", {"stage": "rewrite", "status": "fallback", "preview": "Falling back to minimal filler removal (no AI)"}),
               ("stage", {"stage": "rewrite", "status": "done", "ms": 3}), ("stage", {"stage": "guard", "status": "done", "ms": 40})]
    elif name == "fallback-selfcorrected":  # Gemini out of credits -> deterministic rung resolves "Friday, no wait, Monday"
        fixed = "My name is Ariane Patel and the team meeting is on Monday at five p m."
        done.update(rung="minimal", rewrite=fixed, guard=guard(),
                    edits=[{"from": "So um", "to": "", "reason": "filler"}, {"from": "uh Friday, no wait,", "to": "", "reason": "self_correction"}],
                    notes=["AI editor unavailable: Gemini key has no credits (402) - add billing in AI Studio",
                           "Self-corrections fixed by rules (AI editor unavailable)"],
                    trace=head + [tr("decide", ms=900, model="gpt-6-luna"),
                                  tr("rewrite", False, 300, "gemma-4-26b-a4b-it", error="ClientError: 402 RESOURCE_EXHAUSTED prepayment credits are depleted"),
                                  tr("rewrite", True, 3, "deterministic", preview=fixed), tr("guard", True, 40, "deterministic+decisions", preview="PASS")])
    elif name == "fallback-original":
        done.update(rung="original", rewrite=VERBATIM, guard=guard(), notes=["ladder: no changes made"],
                    trace=head + [tr("decide", ms=900, model="gpt-6-luna"),
                                  tr("rewrite", False, 20000, "gemma-4-26b-a4b-it", error="TimeoutError: Gemini did not answer within 20 s"),
                                  tr("rewrite", True, 3, "deterministic", preview=MINIMAL),
                                  tr("guard", True, 30, "deterministic+decisions", preview="FAIL: Friday was corrected to Monday but still appears (verifier offline)")])
    elif name == "fallback-watchdog":  # backend/main.py JOB_DEADLINE_S hit: no rewrite trace entry, just the note
        done.update(rung="original", rewrite=VERBATIM, guard=guard(), notes=["ladder: watchdog timeout - no changes made"],
                    trace=head + [tr("decide", ms=900, model="gpt-6-luna")])
    else:  # ok / speak scenarios
        done.update(rung="full", rewrite=REWRITE, guard=guard(),
                    edits=[{"from": "So um", "to": "", "reason": "filler"}, {"from": "uh Friday, no wait,", "to": "", "reason": "self_correction"}],
                    decisions={"predicates": {"has_filler": 0.97, "has_self_correction": 0.95}, "register": "announcement", "recommended_mode": "presenter", "per_sentence": []},
                    trace=head + [tr("decide", ms=900, model="gpt-6-luna"), tr("rewrite", ms=4000, model="gemma-4-26b-a4b-it", preview=REWRITE), tr("guard", ms=300, preview="PASS")])
        ev += [("stage", {"stage": "rewrite", "status": "start"}), ("stage", {"stage": "rewrite", "status": "done", "ms": 4000}),
               ("stage", {"stage": "guard", "status": "start"}), ("stage", {"stage": "guard", "status": "done", "ms": 300})]
    return ev, done, j


@app.post("/__scenario")
async def set_scenario(req: Request):
    body = await req.json()
    state["scenario"] = body["name"]
    state["health"] = {**HEALTH_OK, **body.get("health", {})}
    state["live"] = body.get("live", "ok")
    state.update(live_calls=[], live_max=0)
    speaks.clear()
    return {"scenario": state["scenario"]}


@app.get("/__live_calls")
async def live_calls():
    return {"calls": state["live_calls"], "max_inflight": state["live_max"]}


@app.get("/api/health")
async def health():
    return state["health"]


# Live draft per the round-3 contract: cumulative audio + seq -> rough text. "busy" answers 429 on every
# other call (a pass already running); "404" pretends the endpoint has not landed.
@app.post("/api/live")
async def live(audio: UploadFile, seq: int = Form(...)):
    data = await audio.read()
    state["live_calls"].append({"seq": seq, "bytes": len(data), "webm_header": data[:4].hex() == "1a45dfa3"})
    if state["live"] == "404":
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    if state["live"] == "busy" and seq % 2 == 0:
        return JSONResponse({"error": {"code": "busy", "message": "A live pass is already running.", "hint": ""}}, status_code=429)
    state["live_inflight"] += 1
    state["live_max"] = max(state["live_max"], state["live_inflight"])
    try:
        await asyncio.sleep(1.2 if state["live"] == "slow" else 0.3)
    finally:
        state["live_inflight"] -= 1
    words = VERBATIM.split()
    return {"seq": seq, "text": " ".join(words[: min(len(words), seq * 5)]), "ms": 300, "final": False}


@app.post("/api/process", status_code=202)
async def process(audio: UploadFile, mode: str = Form("auto"), protected_terms: str = Form("")):
    jid = str(uuid.uuid4())
    terms = [t.strip() for t in protected_terms.split(",") if t.strip()]
    ev, done, snap = build(state["scenario"], jid, terms)
    jobs[jid] = {"events": ev, "done": done, "snap": snap, "name": state["scenario"]}
    return {"job_id": jid}


@app.get("/api/jobs/{jid}/events")
async def events(jid: str):
    job = jobs[jid]
    if job["name"] == "stall-poll":  # SSE broken: client must fall back to polling
        return JSONResponse({"error": {"code": "internal", "message": "no SSE", "hint": ""}}, status_code=500)

    async def gen():
        for name, data in job["events"]:
            await asyncio.sleep(0.3)
            yield f"event: {name}\ndata: {json.dumps(data)}\n\n"
        if job["done"] is None:
            while True:  # hung stage: keep-alive comments only, never progress
                await asyncio.sleep(5)
                yield ": keep-alive\n\n"
        yield f"event: result\ndata: {json.dumps(job['done'])}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/jobs/{jid}")
async def get_job(jid: str):
    job = jobs.get(jid)
    if not job:
        return JSONResponse({"error": {"code": "not_found", "message": "Unknown job.", "hint": ""}}, status_code=404)
    return job["done"] or job["snap"]


@app.post("/api/rewrite")
async def rewrite(req: Request):
    body = await req.json()
    job = jobs[body["job_id"]]
    out = dict(job["done"] or job["snap"])
    if body.get("edited_text") is not None:
        bad = "friday" in body["edited_text"].lower() and "monday" not in body["edited_text"].lower()
        out.update(rewrite=body["edited_text"], guard=guard(not bad))
    return out


SPEAK_ERRORS = {  # shapes mirror backend/errors.py + backend/voice.py
    "voice_starting": (500, "internal", "Twinly voice is still starting.", "Wait a few seconds and retry."),
    "voice_not_set_up": (409, "voice_not_set_up", "Your Twinly voice clone isn't set up.", "Build your clone in Twinly."),
    "twinly_offline": (409, "twinly_offline", "Twinly is offline.", "Open the Twinly app."),
    "rate_limited": (429, "rate_limited", "Twinly rate limit hit.", "Wait a minute and try again."),
    "job_unverified": (503, "job_unverified", "Twinly could not confirm whether the line was spoken.", "Check the Twinly app."),
}


# Stage segment. Scenario names (POST /__scenario {"name": ...}): pass, held, slow (sleeps 3 s), 500.
# Any other scenario behaves as pass. consent=1 and a passing guard enqueue a speak the client can poll.
HELD_GUARD = {"pass": False, "violations": [
    {"rule": "superseded_value", "original_span": "Friday", "rewrite_span": "Friday",
     "message": "You corrected Friday to Monday, but the rewrite says Friday."}],
    "decisions_probs": {}, "verifier": "offline"}


def _stage_name(name: str) -> str:
    return name.removeprefix("stage-")


@app.post("/api/stage/segment")
async def stage_segment(audio: UploadFile, session: str = Form(...), segment: int = Form(...),
                        protected_terms: str = Form(""), consent: str = Form("0")):
    del audio, protected_terms, session
    name = _stage_name(state["scenario"])
    if name == "500":
        return JSONResponse({"error": {"code": "internal", "message": "Stage segment failed.", "hint": "Try the sentence again."}},
                            status_code=500)
    if name == "slow":
        await asyncio.sleep(3)
    held = name == "held"
    consent_on = consent in ("1", "true", "True")
    speak_id = None
    job_id = str(uuid.uuid4())
    if not held and consent_on:
        speak_id = str(uuid.uuid4())
        speaks[speak_id] = {
            "speak_id": speak_id, "job_id": job_id, "status": "done",
            "chunks": [{"url": "/api/audio/demo.m4a", "seconds": 3.84, "cached": False}],
            "total_chunks": 1, "queue_position": 0, "error": None, "ms": 800, "synthetic": True,
            "render_started_ms": 40, "first_chunk_ms": 800,
        }
    return {
        "job_id": job_id, "segment": segment,
        "verbatim": VERBATIM, "rewrite": MINIMAL if held else REWRITE,
        "guard": HELD_GUARD if held else guard(),
        "speak_id": speak_id, "held": held,
        "timings": {"asr_ms": 420, "rewrite_ms": 18, "guard_ms": 12, "total_ms": 480},
    }


@app.get("/api/speak/{speak_id}")
async def speak_status(speak_id: str):
    row = speaks.get(speak_id)
    if row is None:
        return JSONResponse({"error": {"code": "not_found", "message": "Unknown speak.", "hint": ""}}, status_code=404)
    return row


@app.post("/api/speak")
async def speak(req: Request):
    body = await req.json()
    name = state["scenario"].removeprefix("speak-")
    if name in SPEAK_ERRORS:
        status, code, msg, hint = SPEAK_ERRORS[name]
        return JSONResponse({"error": {"code": code, "message": msg, "hint": hint}}, status_code=status)
    await asyncio.sleep(0.5)
    return {"chunks": [{"url": "/api/audio/demo.m4a", "seconds": 9.0, "cached": False}], "total_seconds": 9.0, "ms": 500, "synthetic": True}


@app.get("/api/audio/{name}")
async def audio(name: str):
    return FileResponse(FRONTEND / "demo-clip.m4a", media_type="audio/mp4")


app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8002)
    uvicorn.run(app, host="127.0.0.1", port=ap.parse_args().port, log_level="warning")
