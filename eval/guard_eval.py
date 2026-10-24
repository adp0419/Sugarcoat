"""Measure the deterministic guard's false positives / false negatives on labelled rewrites.

    python eval/guard_eval.py            # table + FP/FN rates, exit 1 if any false positive

Cases: eval/guard_cases.json (hand-written, realistic Gemma-style rewrites, good and bad).
False positive = guard blocks a rewrite a careful human would approve.
False negative = guard passes a rewrite that changed the meaning.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import guard  # noqa: E402


def identity_cases() -> list[dict]:
    """Unchanged text is a good rewrite, except when the verbatim itself breaks its must_drop list
    (e.g. still says "Friday" before the correction): docs/md/08 bans the superseded value outright."""
    out = []
    for u in json.loads((ROOT / "eval" / "utterances.json").read_text()):
        drops = [d for spec in u.get("must_drop", []) for d in ([spec] if isinstance(spec, str) else spec)]
        if any(re.search(rf"(?<!\w){re.escape(d)}(?!\w)", u["text"], re.I) for d in drops
               if d.lower() not in ("um", "uh", "i- i")):
            continue
        out.append({"id": f"utt_{u['id']}", "original": u["text"], "rewrite": u["text"], "expect": "pass",
                    "why": "identity rewrite of an eval utterance"})
    return out


def evaluate(cases: list[dict]) -> list[dict]:
    rows = []
    for c in cases:
        r = guard.check_rules(c["original"], c["rewrite"], protected=c.get("protected", ()))
        got = "pass" if r.passed else "fail"
        rows.append({**c, "got": got, "rules": sorted({v.rule for v in r.violations}),
                     "outcome": "ok" if got == c["expect"] else ("FP" if c["expect"] == "pass" else "FN")})
    return rows


def summary(rows: list[dict]) -> dict:
    good = [r for r in rows if r["expect"] == "pass"]
    bad = [r for r in rows if r["expect"] == "fail"]
    fp = [r for r in good if r["outcome"] == "FP"]
    fn = [r for r in bad if r["outcome"] == "FN"]
    return {"n": len(rows), "good": len(good), "bad": len(bad), "fp": fp, "fn": fn}


def main() -> int:
    cases = json.loads((ROOT / "eval" / "guard_cases.json").read_text())
    extra = identity_cases()
    rows = evaluate(cases + extra)
    s = summary(rows)
    print("| id | expect | guard | outcome | rules |")
    print("|---|---|---|---|---|")
    for r in rows:
        print(f"| {r['id']} | {r['expect']} | {r['got']} | {r['outcome']} | {', '.join(r['rules'])} |")
    print(f"\nn={s['n']} ({s['good']} good rewrites, {s['bad']} bad rewrites)")
    print(f"- false positives (good rewrite blocked): {len(s['fp'])}/{s['good']}"
          + (f" -> {', '.join(r['id'] for r in s['fp'])}" if s['fp'] else ""))
    print(f"- false negatives (bad rewrite passed): {len(s['fn'])}/{s['bad']}"
          + (f" -> {', '.join(r['id'] for r in s['fn'])}" if s['fn'] else ""))
    return 1 if s["fp"] else 0


if __name__ == "__main__":
    sys.exit(main())
