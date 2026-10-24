"""Smoke test against a running server: N x (process demo clip -> poll job) [+ one real speak].

    make smoke                       # 5 runs against http://127.0.0.1:8000
    N=3 BASE=http://127.0.0.1:8001 make smoke
    SPEAK=1 make smoke               # also one /api/speak (~$0.10 of Twinly credit) + audio check
    FAST=1 CLIP=fixtures/sentence_short.m4a make smoke          # stage-mode fast path, one sentence
    FAST=1 SPEAK=1 N=1 CLIP=fixtures/sentence_short.m4a make smoke  # + /api/speak/async: time to first audio

Exits non-zero if any run fails, any run takes > 60 s, or the speak check fails.
"""
import argparse
import os
import statistics
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
MAX_RUN_S = 60.0
POLL_S = 0.5


def run_once(c: httpx.Client, clip: Path, mode: str, fast: bool = False) -> tuple[bool, dict | None, float]:
    t = time.perf_counter()
    r = c.post("/api/process", files={"audio": (clip.name, clip.read_bytes(), "audio/mp4")},
               data={"mode": mode, "fast": "1" if fast else "0"})
    if r.status_code != 202:
        print(f"  process -> {r.status_code} {r.text[:200]}")
        return False, None, time.perf_counter() - t
    jid = r.json()["job_id"]
    job = None
    while time.perf_counter() - t < MAX_RUN_S:
        job = c.get(f"/api/jobs/{jid}").json()
        if job.get("status") != "running":
            break
        time.sleep(POLL_S)
    wall = time.perf_counter() - t
    if not job or job.get("status") != "ready":
        err = (job or {}).get("error") or {}
        print(f"  job {jid[:8]} status={(job or {}).get('status')} {err.get('code', '')} {err.get('message', '')}")
        return False, job, wall
    stages = "  ".join(f"{e['stage']}{'' if e['ok'] else '!'}={e['ms']}ms" for e in job["trace"])
    g = job.get("guard") or {}
    print(f"  {stages}")
    print(f"  rung={job['rung']} mode={job['mode_used']} guard={'PASS' if g.get('pass') else 'FAIL'} "
          f"verifier={g.get('verifier')} total={job['timings']['total_ms']}ms wall={wall:.1f}s")
    print(f"  verbatim: {job['verbatim'][:140]}")
    print(f"  rewrite:  {job['rewrite'][:140]}")
    for n in job.get("notes") or []:
        print(f"  note: {n}")
    return wall <= MAX_RUN_S, job, wall


def speak_check(c: httpx.Client, job: dict) -> bool:
    t = time.perf_counter()
    r = c.post("/api/speak", json={"job_id": job["id"], "text": job["rewrite"]}, timeout=90)
    if r.status_code != 200:
        print(f"  speak -> {r.status_code} {r.text[:300]}")
        return False
    res = r.json()
    print(f"  speak: {len(res['chunks'])} chunk(s), {res['total_seconds']:.1f} s audio, "
          f"{(time.perf_counter() - t):.1f} s wall, cached={[ch['cached'] for ch in res['chunks']]}")
    ok = True
    for ch in res["chunks"]:
        a = c.get(ch["url"])
        ctype = a.headers.get("content-type", "")
        print(f"  audio {ch['url'][-20:]}: {a.status_code} {ctype} {len(a.content)} bytes")
        ok &= a.status_code == 200 and ctype.startswith("audio/mp4") and len(a.content) > 1000
    return ok


def speak_async_check(c: httpx.Client, job: dict, process_wall: float) -> bool:
    """Stage mode: queue the text, poll until the first chunk is playable. Prints time to first audio."""
    t = time.perf_counter()
    r = c.post("/api/speak/async", json={"job_id": job["id"], "text": job["rewrite"]})
    if r.status_code != 202:
        print(f"  speak/async -> {r.status_code} {r.text[:300]}")
        return False
    sid, first, s = r.json()["speak_id"], None, {}
    while time.perf_counter() - t < 90:
        s = c.get(f"/api/speak/{sid}").json()
        if s.get("chunks") and first is None:
            first = time.perf_counter() - t
        if s.get("status") in ("done", "failed"):
            break
        time.sleep(0.25)
    if s.get("status") != "done" or first is None:
        print(f"  speak/async ended {s.get('status')}: {s.get('error')}")
        return False
    print(f"  speak/async: first chunk after {first:.1f} s, {len(s['chunks'])} chunk(s), "
          f"{sum(ch['seconds'] for ch in s['chunks']):.1f} s audio, cached={[ch['cached'] for ch in s['chunks']]}")
    print(f"  time to first audio (process {process_wall:.1f} s + render {first:.1f} s, upload->playable): "
          f"{process_wall + first:.1f} s")
    a = c.get(s["chunks"][0]["url"])
    print(f"  audio: {a.status_code} {a.headers.get('content-type')} {len(a.content)} bytes")
    return a.status_code == 200 and a.headers.get("content-type", "").startswith("audio/mp4")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("BASE", "http://127.0.0.1:8000"))
    ap.add_argument("-n", type=int, default=int(os.environ.get("N", "5")))
    ap.add_argument("--clip", default=os.environ.get("CLIP", str(ROOT / "frontend" / "demo-clip.m4a")))
    ap.add_argument("--mode", default=os.environ.get("MODE", "auto"))
    ap.add_argument("--speak", action="store_true", default=os.environ.get("SPEAK") == "1")
    ap.add_argument("--fast", action="store_true", default=os.environ.get("FAST") == "1",
                    help="stage-mode fast path; with --speak uses /api/speak/async")
    a = ap.parse_args()

    clip = Path(a.clip)
    with httpx.Client(base_url=a.base, timeout=30) as c:
        try:
            h = c.get("/api/health").json()
        except httpx.HTTPError as e:
            print(f"server not reachable at {a.base}: {type(e).__name__}. Start it with `make run`.")
            return 2
        print(f"health: {h}")
        fails, walls, last = 0, [], None
        for i in range(a.n):
            print(f"run {i + 1}/{a.n}")
            ok, job, wall = run_once(c, clip, a.mode, a.fast)
            walls.append(wall)
            fails += not ok
            last = job if ok else last
        print(f"\n{a.n - fails}/{a.n} ok{' (fast=1)' if a.fast else ''}; wall s: "
              + ", ".join(f"{w:.2f}" for w in walls) + f"; p50 {statistics.median(walls):.2f}; max {max(walls):.2f}")
        if a.speak:
            if last is None:
                print("speak: skipped (no successful job)")
                return 1
            print("speak (real Twinly call, ~$0.10):")
            if not (speak_async_check(c, last, walls[-1]) if a.fast else speak_check(c, last)):
                print("speak check FAILED")
                return 1
            print("speak check ok")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
