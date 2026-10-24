"""Smoke test against a running server: N x (process demo clip -> poll job) [+ one real speak].

    make smoke                       # 5 runs against http://127.0.0.1:8000
    N=3 BASE=http://127.0.0.1:8001 make smoke
    SPEAK=1 make smoke               # also one /api/speak (~$0.10 of Twinly credit) + audio check

Exits non-zero if any run fails, any run takes > 60 s, or the speak check fails.
"""
import argparse
import os
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
MAX_RUN_S = 60.0
POLL_S = 0.5


def run_once(c: httpx.Client, clip: Path, mode: str) -> tuple[bool, dict | None, float]:
    t = time.perf_counter()
    r = c.post("/api/process", files={"audio": (clip.name, clip.read_bytes(), "audio/mp4")}, data={"mode": mode})
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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("BASE", "http://127.0.0.1:8000"))
    ap.add_argument("-n", type=int, default=int(os.environ.get("N", "5")))
    ap.add_argument("--clip", default=os.environ.get("CLIP", str(ROOT / "frontend" / "demo-clip.m4a")))
    ap.add_argument("--mode", default=os.environ.get("MODE", "auto"))
    ap.add_argument("--speak", action="store_true", default=os.environ.get("SPEAK") == "1")
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
            ok, job, wall = run_once(c, clip, a.mode)
            walls.append(wall)
            fails += not ok
            last = job if ok else last
        print(f"\n{a.n - fails}/{a.n} ok; wall s: " + ", ".join(f"{w:.1f}" for w in walls)
              + f"; max {max(walls):.1f}")
        if a.speak:
            if last is None:
                print("speak: skipped (no successful job)")
                return 1
            print("speak (real Twinly call, ~$0.10):")
            if not speak_check(c, last):
                print("speak check FAILED")
                return 1
            print("speak check ok")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
