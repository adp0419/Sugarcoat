"""Stage-mode latency bench. No microphone, no playback, no Twinly speak unless the server is MOCK=1.

Splits each fixture on silence (ffmpeg silencedetect; the whole file if there is no gap; fixed
4 s cuts only if silencedetect itself fails). Posts each segment to POST /api/stage/segment at
real-time pace (when that segment ends in the file). Default --no-speak sends consent=0 and
estimates the render from logs/twinly_renders.jsonl instead of polling /api/speak.

    python scripts/bench_pipeline.py --url http://127.0.0.1:8000 --fixtures fixtures
    python scripts/bench_pipeline.py --json bench.json
    python scripts/bench_pipeline.py --speak          # refused unless /api/health says mock=true

End-of-sentence → audio is estimated as cut delay (0.5 s and 0.9 s) + server total + render.
It does not include a click. Queue wait is simulated for --no-speak (one render at a time) and
measured from render_started_ms when --speak is polling a mock server.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
RENDER_LOG = ROOT / "logs" / "twinly_renders.jsonl"
SHORT_CHARS = 120          # stage lines are one sentence; longer rows are multi-chunk quality renders
BASELINE_RENDER_MS = 5900  # PROGRESS: one 44-char line, quality model, when the log is missing
CUT_LO_S = 0.5
CUT_HI_S = 0.9
FIXED_CUT_S = 4.0
MIN_SPEECH_S = 0.30
POST_TIMEOUT_S = 60.0
SPEAK_TIMEOUT_S = 30.0


def percentile(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    if len(xs) == 1:
        return float(xs[0])
    k = (len(xs) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def duration_s(path: Path) -> float:
    if not shutil.which("ffprobe"):
        raise SystemExit("ffprobe is not on PATH (brew install ffmpeg)")
    r = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)])
    if r.returncode != 0 or not r.stdout.strip():
        raise SystemExit(f"ffprobe failed for {path.name}: {r.stderr.strip()[:200]}")
    return float(r.stdout.strip())


def _silence_intervals(path: Path) -> list[tuple[float, float]] | None:
    """None means silencedetect failed. [] means it ran and found no silence."""
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is not on PATH (brew install ffmpeg)")
    r = _run(["ffmpeg", "-i", str(path), "-af", "silencedetect=noise=-35dB:d=0.35", "-f", "null", "-"])
    if r.returncode != 0:
        return None
    starts: list[float] = []
    intervals: list[tuple[float, float]] = []
    for line in (r.stderr or "").splitlines():
        if "silence_start:" in line:
            starts.append(float(line.split("silence_start:", 1)[1].split()[0]))
        elif "silence_end:" in line and starts:
            end = float(line.split("silence_end:", 1)[1].split("|", 1)[0].strip())
            intervals.append((starts.pop(0), end))
    dur = duration_s(path)
    for start in starts:  # silence ran to EOF
        intervals.append((start, dur))
    return intervals


def speech_spans(path: Path) -> list[tuple[float, float]]:
    dur = duration_s(path)
    if dur <= 0:
        raise SystemExit(f"{path.name} has no duration")
    intervals = _silence_intervals(path)
    if intervals is None:
        spans = []
        t = 0.0
        while t < dur - 0.05:
            spans.append((round(t, 3), round(min(dur, t + FIXED_CUT_S), 3)))
            t += FIXED_CUT_S
        return spans or [(0.0, round(dur, 3))]
    cursor = 0.0
    spans: list[tuple[float, float]] = []
    for start, end in intervals:
        if start - cursor >= MIN_SPEECH_S:
            spans.append((round(cursor, 3), round(start, 3)))
        cursor = max(cursor, end)
    if dur - cursor >= MIN_SPEECH_S:
        spans.append((round(cursor, 3), round(dur, 3)))
    return spans or [(0.0, round(dur, 3))]


def cut_segment(src: Path, start: float, end: float, dest: Path) -> None:
    r = _run(["ffmpeg", "-y", "-i", str(src), "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
              "-ac", "1", "-ar", "16000", str(dest)])
    if r.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        raise SystemExit(f"ffmpeg cut failed ({src.name} {start}-{end}): {r.stderr.strip()[:200]}")


def load_render_history(path: Path = RENDER_LOG) -> dict:
    rows: list[dict] = []
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    ok = [r for r in rows if not r.get("failed") and isinstance(r.get("ms"), (int, float))]
    short = [r for r in ok if isinstance(r.get("chars"), int) and r["chars"] <= SHORT_CHARS]
    used = short or ok
    ms = [float(r["ms"]) for r in used]
    return {
        "path": str(path),
        "n": len(used),
        "which": "short lines" if short else ("all successful renders" if ok else "baseline 5.9 s"),
        "p50_ms": percentile(ms, 50) if ms else float(BASELINE_RENDER_MS),
        "p90_ms": percentile(ms, 90) if ms else float(BASELINE_RENDER_MS),
    }


def summarize(rows: list[dict], keys: list[str]) -> dict:
    out = {}
    for key in keys:
        vals = [float(r[key]) for r in rows if r.get(key) is not None]
        out[key] = {"n": len(vals), "p50": percentile(vals, 50), "p90": percentile(vals, 90)}
    return out


def _fixtures(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    files = sorted(p for p in path.iterdir() if p.suffix.lower() in {".m4a", ".wav", ".webm", ".mp3", ".mp4"})
    if not files:
        raise SystemExit(f"no audio in {path}")
    return files


def _health(client: httpx.Client) -> dict:
    try:
        r = client.get("/api/health")
    except httpx.HTTPError as e:
        raise SystemExit(f"cannot reach the server: {e}") from e
    if r.status_code != 200:
        raise SystemExit(f"/api/health -> {r.status_code} {r.text[:200]}")
    return r.json()


def _poll_speak(client: httpx.Client, speak_id: str) -> dict:
    deadline = time.perf_counter() + SPEAK_TIMEOUT_S
    last: dict = {}
    while time.perf_counter() < deadline:
        r = client.get(f"/api/speak/{speak_id}")
        if r.status_code != 200:
            time.sleep(0.2)
            continue
        last = r.json()
        if last.get("first_chunk_ms") is not None or last.get("status") in ("done", "failed"):
            return last
        if last.get("chunks"):
            return last
        time.sleep(0.2)
    return last


def run_file(client: httpx.Client, src: Path, *, consent: str, speak: bool, render_ms: float) -> list[dict]:
    spans = speech_spans(src)
    session = "bench-" + uuid.uuid4().hex[:10]
    origin = time.perf_counter()
    rows: list[dict] = []
    free_at = 0.0  # simulated render queue, seconds from origin
    with tempfile.TemporaryDirectory(prefix="vf-bench-") as tmp:
        for i, (start, end) in enumerate(spans):
            wait = end - (time.perf_counter() - origin)
            if wait > 0:
                time.sleep(wait)
            posted = time.perf_counter() - origin
            whole = len(spans) == 1 and abs(start) < 0.01 and abs(end - duration_s(src)) < 0.05
            if whole:
                mime = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".wav": "audio/wav",
                        ".webm": "audio/webm", ".mp3": "audio/mpeg"}.get(src.suffix.lower(), "application/octet-stream")
                payload, name = src.read_bytes(), src.name
            else:
                dest = Path(tmp) / f"{i}.wav"
                cut_segment(src, start, end, dest)
                payload, name, mime = dest.read_bytes(), dest.name, "audio/wav"
            t = time.perf_counter()
            r = client.post(
                "/api/stage/segment",
                files={"audio": (name, payload, mime)},
                data={"session": session, "segment": str(i), "consent": consent, "protected_terms": ""},
                timeout=POST_TIMEOUT_S,
            )
            wall_ms = (time.perf_counter() - t) * 1000
            if r.status_code == 404:
                raise SystemExit("POST /api/stage/segment returned 404. The endpoint has not landed.")
            if r.status_code != 200:
                raise SystemExit(f"{src.name} segment {i} -> {r.status_code} {r.text[:300]}")
            body = r.json()
            timings = body.get("timings") or {}
            total_ms = float(timings.get("total_ms", wall_ms))
            row = {
                "file": src.name,
                "segment": i,
                "start_s": start,
                "end_s": end,
                "posted_s": round(posted, 3),
                "asr_ms": timings.get("asr_ms"),
                "rewrite_ms": timings.get("rewrite_ms"),
                "guard_ms": timings.get("guard_ms"),
                "total_ms": timings.get("total_ms"),
                "wall_ms": round(wall_ms, 1),
                "guard_pass": (body.get("guard") or {}).get("pass"),
                "held": body.get("held"),
                "speak_id": body.get("speak_id"),
            }
            if speak and body.get("speak_id"):
                st = _poll_speak(client, body["speak_id"])
                started = st.get("render_started_ms")
                first = st.get("first_chunk_ms")
                row["queue_wait_ms"] = started
                if started is not None and first is not None:
                    row["render_to_first_ms"] = max(0.0, float(first) - float(started))
                elif first is not None:
                    row["render_to_first_ms"] = float(first)
                else:
                    row["render_to_first_ms"] = None
                row["speak_status"] = st.get("status")
            else:
                if body.get("speak_id"):
                    print(f"  warning: {src.name} segment {i} returned speak_id with consent={consent}", file=sys.stderr)
                ready = posted + total_ms / 1000.0
                start_render = max(ready, free_at)
                row["queue_wait_ms"] = round((start_render - ready) * 1000, 1)
                row["render_to_first_ms"] = round(render_ms, 1)
                row["render_estimated"] = True
                free_at = start_render + render_ms / 1000.0
            render_used = row.get("render_to_first_ms")
            if render_used is None:
                render_used = render_ms
            total_s = total_ms / 1000.0
            row["eos_lo_ms"] = round((CUT_LO_S + total_s) * 1000 + render_used, 1)
            row["eos_hi_ms"] = round((CUT_HI_S + total_s) * 1000 + render_used, 1)
            row["eos_lo_with_queue_ms"] = round(row["eos_lo_ms"] + (row.get("queue_wait_ms") or 0), 1)
            rows.append(row)
            print(f"  {src.name} seg {i} ({start:.2f}-{end:.2f}s) "
                  f"asr={row['asr_ms']} rewrite={row['rewrite_ms']} guard={row['guard_ms']} "
                  f"total={row['total_ms']} queue={row.get('queue_wait_ms')} "
                  f"render={row.get('render_to_first_ms')} "
                  f"eos={row['eos_lo_ms']/1000:.1f}-{row['eos_hi_ms']/1000:.1f}s")
    return rows


def _fmt(ms: float | None) -> str:
    if ms is None:
        return "—"
    return f"{ms / 1000:.2f}s" if ms >= 1000 else f"{ms:.0f}ms"


def print_table(summary: dict, history: dict) -> None:
    print()
    print(f"render estimate: {history['which']}, n={history['n']}, "
          f"p50={_fmt(history['p50_ms'])} p90={_fmt(history['p90_ms'])} ({history['path']})")
    print(f"{'metric':<28} {'p50':>10} {'p90':>10} {'n':>4}")
    labels = [
        ("asr_ms", "asr"),
        ("rewrite_ms", "rewrite"),
        ("guard_ms", "guard"),
        ("total_ms", "total server"),
        ("queue_wait_ms", "queue wait"),
        ("render_to_first_ms", "render → first chunk"),
        ("eos_lo_ms", "eos → audio (cut 0.5s)"),
        ("eos_hi_ms", "eos → audio (cut 0.9s)"),
        ("eos_lo_with_queue_ms", "eos + queue (cut 0.5s)"),
    ]
    for key, label in labels:
        cell = summary.get(key) or {}
        print(f"{label:<28} {_fmt(cell.get('p50')):>10} {_fmt(cell.get('p90')):>10} {cell.get('n', 0):>4}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Bench POST /api/stage/segment. Does not call Twinly unless --speak on a MOCK server.")
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--fixtures", default=str(ROOT / "fixtures"))
    ap.add_argument("--json", metavar="PATH", help="write the report JSON (use - for stdout only)")
    ap.add_argument("--no-speak", dest="no_speak", action="store_true", default=True,
                    help="skip the render and estimate it from logs/twinly_renders.jsonl (default)")
    ap.add_argument("--speak", dest="no_speak", action="store_false",
                    help="consent=1 and poll /api/speak. Refused unless the server is MOCK=1")
    args = ap.parse_args(argv)

    files = _fixtures(Path(args.fixtures))
    history = load_render_history()
    with httpx.Client(base_url=args.url.rstrip("/"), timeout=POST_TIMEOUT_S) as client:
        health = _health(client)
        if not args.no_speak and not health.get("mock"):
            raise SystemExit("refusing --speak: /api/health mock is not true. This bench never calls Twinly on a real server.")
        speak = not args.no_speak
        consent = "1" if speak else "0"
        print(f"url={args.url} mock={health.get('mock')} speak={speak} files={len(files)}")
        rows: list[dict] = []
        for src in files:
            rows.extend(run_file(client, src, consent=consent, speak=speak, render_ms=history["p50_ms"]))
    keys = ["asr_ms", "rewrite_ms", "guard_ms", "total_ms", "queue_wait_ms",
            "render_to_first_ms", "eos_lo_ms", "eos_hi_ms", "eos_lo_with_queue_ms"]
    summary = summarize(rows, keys)
    report = {
        "url": args.url,
        "speak": speak,
        "mock": health.get("mock"),
        "cut_delay_s": [CUT_LO_S, CUT_HI_S],
        "render_history": history,
        "segments": rows,
        "summary": summary,
    }
    if not (args.json == "-"):
        print_table(summary, history)
    if args.json:
        text = json.dumps(report, indent=1)
        if args.json == "-":
            print(text)
        else:
            Path(args.json).write_text(text + "\n")
            print(f"wrote {args.json}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
