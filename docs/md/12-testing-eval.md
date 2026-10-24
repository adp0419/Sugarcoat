# 12 Testing & evaluation

Evidence of rigor = "Technical Execution" points. Keep it small and runnable.

## Unit tests (pytest, no network, <2 s)
- `test_guard.py` — ≥25 cases from 08 (dates, times, numbers, negation, hedges, quantifiers, self-correction, spoken numbers).
- `test_split.py` — sentence + chunk packing: never >550 chars, never mid-sentence, order preserved.
- `test_minimal.py` — deterministic filler remover: "um, I- I want uh to go" → "I want to go"; preserves "like" as verb ("I like it").
- `test_parse.py` — Gemma JSON parser: fenced JSON, trailing text, invalid → raises → ladder.
- `test_twinly_client.py` — httpx MockTransport: 202→poll→done; 429 retry; 503 job_unverified never re-POSTs; 409 offline mapping.

## Integration smoke (`scripts/smoke.sh`, needs keys)
`GET /api/health` → `POST /api/process` with `eval/audio/01_canonical.webm` → assert verbatim contains "um" and "Monday", rewrite contains "Monday" and not "Friday", guard.pass true.
One real Twinly speak only behind `SMOKE_SPEAK=1` (costs $0.10).

## Eval harness (`eval/run_eval.py`)
`eval/utterances.json`: 12–15 items `{id, audio?, text, must_keep[], must_drop[], tricky}`.
Run text-only (skip ASR) for speed: verbatim → decide → rewrite → guard, for each mode. Output markdown table:
| id | mode | rung | guard | must_keep ok | must_drop ok | words in→out | ms |
Metrics for README/pitch: meaning-preservation rate (guard pass without fallback), fallback rate, avg filler reduction, avg latency. Report honestly with n.
Include 3 adversarial items: hedges, negations, numbers-heavy ("flight 482 leaves gate 17 at 6:45").
Include 1 "already fluent" item → must return unchanged (tests the Decisions "leave unchanged" role).

## Human check
Each teammate listens to 3 generated outputs and rates "sounds like me" 1–5 + "meaning kept" y/n. Put the tiny table in the README (be honest, n small).

## Regression rule
Before any demo-bound commit: `pytest -q && python eval/run_eval.py --text-only` — no new fails.

## Reliability soak (Sat night / Sun AM)
Run canonical demo 10× through the full pipeline (Twinly on 3 of them): record success count, p50/p95 latency. Fix top failure cause. Need ≥9/10 before recording the video.

## Cost tracker
`voice.py` increments a counter in `logs/spend.json` per real POST (0.10) and prints running total at startup; refuse >150 lines without `ALLOW_SPEND=1`.

## Test data hygiene
Audio of teammates = consent from them; don't commit audio containing others' voices or private info. Commit only synthetic/own clips under `eval/audio/` (small, ≤20 s).

## What to log in DIFFICULTIES.md
Each failure: symptom → cause → fix/workaround → time lost. 8–10 entries is a strong "difficulties faced" answer for the Vobile challenge.
