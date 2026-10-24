# 02 Architecture

```
Browser (MediaRecorder webm/opus)
  │ POST /api/process (multipart audio, mode)         ◄── SSE /api/jobs/{id}/events
  ▼
FastAPI ── ffmpeg → 16kHz mono wav
  ├─ asr.py      CrisperWhisper 2.0 (verbatim; intended = reference)
  ├─ decide.py   OpenAI Decisions API (mode + per-sentence keep/edit)
  ├─ rewrite.py  Gemma 4 via Gemini API (edit, temp 0, JSON out)
  ├─ guard.py    regex facts + Decisions predicates → pass/fail
  │      fail → retry stricter → minimal deterministic → original
  └─ voice.py    Twinly /v1/voice/speak (≤600 chars chunks, 2 concurrent)
  ▼
Browser: approve text → POST /api/speak → poll → ordered <audio> playback
```

## Principles
- Two-phase flow: `/api/process` (ASR→guard, returns text + trace) and `/api/speak` (after approval). Saves credits, enforces consent.
- In-memory job store (dict) keyed by uuid; no DB. State lost on restart — fine.
- Stage = async function `(input) -> StageResult{ok, data, ms, error}`. Orchestrator in `main.py` appends to `trace[]` and pushes SSE.
- CPU-bound ASR runs in `run_in_executor` (don't block event loop). Load model once at startup (warm-up call with 1 s silence).
- Audio cache: `cache/{sha256(text+voice)}.m4a`; check before calling Twinly.
- Timeouts: ASR 60 s, Decisions 15 s, Gemma 20 s, Twinly job 60 s. Every external call wrapped with retry(2, backoff) except Twinly POST on `job_unverified`.

## Layout
```
backend/ main.py asr.py decide.py rewrite.py guard.py voice.py models.py config.py
frontend/ index.html app.ts style.css
eval/ utterances.json run_eval.py
fixtures/ (mock responses, backup demo audio)
cache/ (gitignored)  .env.example  LICENSE  README.md  DIFFICULTIES.md
```

## Config (config.py, pydantic-settings)
TWINLY_API_KEY, TWINLY_BASE, OPENAI_API_KEY, DECISIONS_MODEL=gpt-6-luna, GEMINI_API_KEY, GEMMA_MODEL=gemma-4-26b-a4b-it, ASR_SIZE=turbo, MOCK=0, PORT=8000.

## CORS / serving
Serve frontend statically from FastAPI (`StaticFiles`) → same origin, no CORS pain. Mic needs secure context: `http://localhost` is OK; do not demo via LAN IP.

## Observability
Each trace entry: `{stage, ok, ms, input_preview, output_preview, model, error?}`. Dump full trace to `logs/{job}.json`. UI renders it; judges love it.
