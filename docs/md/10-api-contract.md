# 10 Backend API contract (frontend ⇄ backend)

All JSON, same origin. Types live in `backend/models.py` (pydantic); mirror in `frontend/types.ts`.

## POST /api/process
multipart: `audio` (blob), `mode` (`auto|minimal|natural|presenter`, default auto), `protected_terms` (optional comma list).
→ 202 `{ "job_id": "uuid" }`. Work continues in background.

## GET /api/jobs/{id}/events (SSE)
Events: `stage` `{stage, status:"start|done|error|fallback", ms, preview}` ; `result` `{Job}` ; `error` `{message}`. Stage names: convert, asr, decide, rewrite, guard.
Fallback: `GET /api/jobs/{id}` returns the current Job (UI polls every 800 ms if EventSource fails).

## Job object
```
{ id, status: "running|ready|failed", mode_used, rung: "full|retry|minimal|original",
  verbatim, sentences[], decisions{ predicates:{name:prob}, register, recommended_mode, per_sentence[] },
  rewrite, edits[{from,to,reason}], guard{pass, violations[], decisions_probs{}, verifier:"online|offline"},
  trace[{stage, ok, ms, model, preview, error?}], timings{total_ms} }
```

## POST /api/rewrite  (re-run with other mode / edited text)
`{job_id, mode}` → new Job fields (reuses ASR). Also `{job_id, edited_text}` when user hand-edits the rewrite → runs guard only against verbatim; failures shown as warnings (user may override with confirm).

## POST /api/speak
`{job_id, text}` (text = approved final) → `{ chunks:[{url, seconds, cached}], total_seconds, ms }`. Blocks until all chunks ready (≤ ~20 s), or 202 + poll `GET /api/speak/{speak_id}` if >25 s. Rejects empty text (400) and >2400 chars (413 — 4 chunks cap protects credits).

## GET /api/audio/{hash}.m4a   serves cached file, `Content-Type: audio/mp4`.
## GET /api/health
`{asr_loaded, decisions:"ok|off|error", gemma:"ok|error", twinly:{online, voice_ready}, mock}`. Calls `GET /v1/me` cached 30 s. Frontend shows status dots; blocks Record when twinly offline (still allows text-only).
## POST /api/eval/run (dev only, `DEV=1`) runs eval/utterances.json, returns table.

## Errors
Uniform `{error:{code, message, hint}}`. Codes: `no_speech`, `asr_failed`, `twinly_offline`, `voice_not_set_up`, `rate_limited`, `job_unverified`, `too_long`, `internal`. `hint` is user-facing fix text.

## Security
Keys only in env. `/api/*` bound to 127.0.0.1 unless `HOST=0.0.0.0` set deliberately. Max upload 10 MB. Delete uploaded audio after ASR unless `KEEP_AUDIO=1` (privacy line for README). Don't log API keys or audio_b64 (log lengths only).

## Mock mode
`MOCK=1`: asr returns fixture text for any audio, decide/rewrite/voice read `fixtures/*.json|m4a` with 300–800 ms artificial sleeps so UI timing looks real. Mandatory so frontend dev never blocks.

## Versioning
No versioning; single deploy. Changing a field = update models.py + types.ts + this file in the same commit.
