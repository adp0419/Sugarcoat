"""Text-only eval: verbatim -> decide -> rewrite -> guard (+ fallback ladder) per mode (docs/md/12).

    python eval/run_eval.py                      # real APIs where keys allow, honest about fallbacks
    python eval/run_eval.py --offline            # no network: deterministic rung + rules-only guard
    python eval/run_eval.py --modes natural --json eval/results.json

Prints a markdown table plus summary metrics with n. A rung other than "full" means the AI rewrite was
rejected or unavailable; the table says so rather than hiding it.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import decide, guard, rewrite as rw, split  # noqa: E402
from backend.config import settings  # noqa: E402

FILLERS = re.compile(r"(?<![\w'-])(?:u+m+|u+h+|e+r+m?|a+h+|you know)(?![\w'-])", re.I)
MODES = ("minimal", "natural", "presenter")


def _present(needle: str, text: str) -> bool:
    if re.search(r"\W", needle[:1] + needle[-1:]) or " " in needle or "-" in needle:
        return needle.lower() in text.lower()
    return re.search(rf"(?<![\w]){re.escape(needle)}(?![\w])", text, re.I) is not None


def _any(spec, text: str) -> bool:
    return any(_present(s, text) for s in ([spec] if isinstance(spec, str) else spec))


def _norm(t: str) -> str:
    return re.sub(r"\W+", " ", t.lower()).strip()


def score(item: dict, out: str) -> tuple[bool, bool]:
    keep = all(_any(k, out) for k in item.get("must_keep", []))
    if item.get("expect_unchanged"):
        keep = keep and _norm(out) == _norm(item["text"])
    drop = not any(_any(d, out) for d in item.get("must_drop", []))
    return keep, drop


async def pipeline(item: dict, mode: str, dec, offline: bool) -> dict:
    text = item["text"]
    t0 = time.perf_counter()
    rung, out, g, violations = "original", text, None, None
    errors: list[str] = []

    async def try_guard(candidate: str):
        return await guard.check(text, candidate, mode=mode)

    if not offline:
        for name in ("full", "retry"):
            try:
                res, _model = await rw.run(text, mode, dec, violations)
            except Exception as e:
                violations = [f"previous attempt failed: {type(e).__name__}"]
                errors.append(f"{type(e).__name__}: {str(e)[:80]}")
                break  # mirrors main.run_ladder: no stricter retry when the rewrite API itself failed
            g = await try_guard(res.rewrite)
            if g.pass_:
                rung, out = name, res.rewrite
                break
            violations = [v.message for v in g.violations]
    if rung == "original":
        cand = rw.minimal(text).rewrite
        if cand.strip():
            g2 = await try_guard(cand)
            if g2.pass_:
                rung, out, g = "minimal", cand, g2
    return {
        "id": item["id"], "mode": mode, "rung": rung, "rewrite": out,
        "guard": (g.pass_ if g else True), "verifier": (g.verifier if g else "offline"),
        "violations": [v.message for v in (g.violations if g else [])],
        "words_in": len(text.split()), "words_out": len(out.split()),
        "fillers_in": len(FILLERS.findall(text)), "fillers_out": len(FILLERS.findall(out)),
        "ms": int((time.perf_counter() - t0) * 1000), "errors": errors,
    }


async def main_async(args) -> int:
    items = json.loads((ROOT / "eval" / "utterances.json").read_text())
    if args.ids:
        items = [i for i in items if i["id"] in args.ids]
    if args.offline:
        settings.DECISIONS_ENABLED = False
    rows = []
    for item in items:
        dec = None
        if not args.offline:
            dec = await decide.analyze(item["text"], split.split_sentences(item["text"]))
        for mode in args.modes:
            r = await pipeline(item, mode, dec, args.offline)
            r["keep_ok"], r["drop_ok"] = score(item, r["rewrite"])
            r["decisions"] = "on" if (dec and dec.available) else "off"
            rows.append(r)

    lines: list[str] = []
    out = lines.append
    out("| id | mode | rung | guard | verifier | decisions | must_keep ok | must_drop ok | words in→out | ms |")
    out("|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        out(f"| {r['id']} | {r['mode']} | {r['rung']} | {'pass' if r['guard'] else 'FAIL'} | {r['verifier']} | {r['decisions']} "
              f"| {'yes' if r['keep_ok'] else 'NO'} | {'yes' if r['drop_ok'] else 'NO'} "
              f"| {r['words_in']}→{r['words_out']} | {r['ms']} |")
    n = len(rows)
    full = sum(r["rung"] == "full" for r in rows)
    fell = sum(r["rung"] in ("minimal", "original") for r in rows)
    fin = sum(r["fillers_in"] for r in rows)
    fout = sum(r["fillers_out"] for r in rows)
    out(f"\nn={n} runs ({len(items)} utterances x {len(args.modes)} modes), offline={args.offline}")
    out(f"- meaning preserved without fallback (guard pass, rung=full): {full}/{n} = {full / n:.0%}" if n else "")
    out(f"- fell back to minimal/original: {fell}/{n} = {fell / n:.0%}" if n else "")
    out(f"- must_keep satisfied: {sum(r['keep_ok'] for r in rows)}/{n}; must_drop satisfied: {sum(r['drop_ok'] for r in rows)}/{n}")
    out(f"- filler reduction: {fin}→{fout}" + (f" ({1 - fout / fin:.0%})" if fin else ""))
    out(f"- avg latency: {sum(r['ms'] for r in rows) // max(n, 1)} ms")
    if any(r["verifier"] == "offline" for r in rows):
        out("- note: AI verifier offline for some/all runs; those results are deterministic-guard only")
    rungs = {k: sum(r["rung"] == k for r in rows) for k in ("full", "retry", "minimal", "original")}
    out(f"- rungs: " + ", ".join(f"{k} {v}" for k, v in rungs.items()))
    errs = sorted({e for r in rows for e in r.get("errors", [])})
    if errs:
        out("- rewrite errors seen: " + "; ".join(errs))
    print("\n".join(lines))
    if args.md:
        head = [f"# Eval results ({time.strftime('%Y-%m-%d %H:%M')})", "",
                f"Command: `python eval/run_eval.py {' '.join(sys.argv[1:])}`. Text-only (no ASR). "
                "Each row: verbatim -> Decisions analysis -> Gemma rewrite -> guard, with the fallback ladder "
                "(full -> retry -> minimal -> original). Generated by eval/run_eval.py; numbers are not edited by hand.", ""]
        Path(args.md).write_text("\n".join(head + lines) + "\n")
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=2))
    bad = [r for r in rows if not (r["keep_ok"] and r["drop_ok"]) or not r["guard"]]
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-only", action="store_true", help="accepted for compatibility; this harness is always text-only")
    ap.add_argument("--offline", action="store_true", help="no network at all")
    ap.add_argument("--modes", type=lambda s: s.split(","), default=list(MODES))
    ap.add_argument("--ids", type=lambda s: s.split(","), default=None)
    ap.add_argument("--json", default=None)
    ap.add_argument("--md", default=None, help="also write the table to this markdown file")
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
