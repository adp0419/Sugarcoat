# 10 Backend API contract (frontend ⇄ backend)

All JSON, same origin. Types live in `backend/models.py` (pydantic); mirror in `frontend/types.ts`.

## POST /api/process
multipart: `audio` (blob), `mode` (`auto|minimal|natural|presenter`, default auto), `protected_terms` (optional comma list).
→ 202 `{ "job_id": "uuid" }`. Work continues in background.

## POST /api/live  (live draft transcript while recording)
multipart: `audio` = the cumulative recording so far (all MediaRecorder chunks from the start, concatenated, so the
webm header is present), `seq` (int, increasing).
→ 200 `{ "seq": int, "text": str, "ms": int, "final": false }`
→ 429 `{error:{code:"busy", message, hint}}` when a live pass is already running, a final `/api/process` ASR is
running (final always has priority), or the speech model is still loading. The client just skips that tick.
→ 413 `too_long` (>10 MB), 415 `unsupported_media`.
Rules: audio is never stored (temp files deleted immediately, `KEEP_AUDIO` ignored); only the first 45 s is
transcribed; one live pass at a time. `text` is a rough draft, not the verbatim of record (the final pass is).
Silence so far returns 200 with `text: ""`. MOCK=1: a growing prefix of the canonical fixture transcript
(6 words per `seq`) after a 300 ms sleep.
Recommended client interval: see "Live latency" below.

### Live latency (measured 2026-10-24, M-series MPS, CrisperWhisper turbo, `say` speech as webm/opus, 3 runs each)
| audio so far | median | runs (ms) |
|---|---|---|
| 5 s | 1.25 s | 1387, 1254, 1245 |
| 10 s | 1.48 s | 1480, 1433, 2092 |
| 20 s | 1.88 s | 2979, 1881, 1708 |
| 40 s (39.1) | 4.05 s | 4150, 4051, 4008 |
(Live passes skip word timestamps; with them the medians were 1.6 / 2.5 / 3.9 / 6.9 s.)

**Recommended client interval: 3000 ms, one request in flight.** Fire a tick every 3 s, but skip it if the
previous `/api/live` has not answered yet (no wasted uploads; the server's 429 `busy` is the backstop). Up to
~20 s of audio the draft refreshes every 3 s; at 40 s every ~4 s. Stop ticking the moment recording stops:
the final `/api/process` ASR refuses new live passes, but the model runs one job at a time, so a live pass that
is already running delays the final one by at most that pass (≤ ~4 s at 40 s, usually ~1.5 s).

## GET /api/jobs/{id}/events (SSE)
Events: `stage` `{stage, status:"start|done|error|fallback", ms, preview}` ; `result` `{Job}` ; `error` `{message}`. Stage names: convert, asr, decide, rewrite, guard.
Fallback: `GET /api/jobs/{id}` returns the current Job (UI polls every 800 ms if EventSource fails).

## Job object
```
{ id, status: "running|ready|failed", mode_used, rung: "full|retry|minimal|original",
  verbatim, sentences[], decisions{ predicates:{name:prob}, register, recommended_mode, per_sentence[] },
  rewrite, edits[{from,to,reason}], guard{pass, violations[], decisions_probs{}, verifier:"online|offline"},
  trace[{stage, ok, ms, model, preview, error?}], timings{total_ms}, notes[] }
```
`notes[]` are UI banners. Exact strings the UI may match: `Self-corrections fixed by rules (AI editor unavailable)`
(the deterministic rung resolved a self-correction because Gemma failed), `AI editor unavailable: <reason>`
(e.g. `Gemini key has no credits (402) - add billing in AI Studio`), `AI verifier offline - deterministic checks only`.

## POST /api/rewrite  (re-run with other mode / edited text)
`{job_id, mode}` → new Job fields (reuses ASR). Also `{job_id, edited_text}` when user hand-edits the rewrite → runs guard only against verbatim; failures shown as warnings (user may override with confirm).

## POST /api/speak
`{job_id, text}` (text = approved final) → `{ chunks:[{url, seconds, cached}], total_seconds, ms }`. Blocks until all chunks ready (≤ ~20 s), or 202 + poll `GET /api/speak/{speak_id}` if >25 s. Rejects empty text (400) and >2400 chars (413 — 4 chunks cap protects credits).

## GET /api/audio/{hash}.m4a   serves cached file, `Content-Type: audio/mp4`.
## GET /api/health
`{asr_loaded, decisions:"ok|off|error|no_credits|auth_error", gemma:"ok|error|no_credits|auth_error", twinly:{online, voice_ready}, mock}`. Calls `GET /v1/me` cached 30 s. Frontend shows status dots; blocks Record when twinly offline (still allows text-only).
Health never makes a paid call. `no_credits` / `auth_error` come from the most recent real call (Gemini 402
RESOURCE_EXHAUSTED "prepayment credits are depleted" / 401 / 403; Decisions 429 `credit_balance_exhausted` or
`insufficient_quota` / 401 / 403), remembered across restarts in `cache/provider_status.json` until a later real
call succeeds. Gemini's free `models.get` succeeds on a key with no credits, so before any real call `gemma:"ok"`
only means "key accepted". Gemma account errors are not retried: the ladder goes straight to the deterministic rung.
## POST /api/eval/run (dev only, `DEV=1`) runs eval/utterances.json, returns table.

## Errors
Uniform `{error:{code, message, hint}}`. Codes: `no_speech`, `asr_failed`, `twinly_offline`, `voice_not_set_up`, `rate_limited`, `job_unverified`, `too_long`, `internal`, `not_found`, `bad_request`, `busy` (429, /api/live), `unsupported_media` (415: upload is not audio; `audio/*`, `video/webm|mp4|quicktime`, `application/octet-stream` accepted). `hint` is user-facing fix text.

## Security
Keys only in env. `/api/*` bound to 127.0.0.1 unless `HOST=0.0.0.0` set deliberately. Max upload 10 MB. Delete uploaded audio after ASR unless `KEEP_AUDIO=1` (privacy line for README). Don't log API keys or audio_b64 (log lengths only).

## Mock mode
`MOCK=1`: asr returns fixture text for any audio, decide/rewrite/voice read `fixtures/*.json|m4a` with 300–800 ms artificial sleeps so UI timing looks real. Mandatory so frontend dev never blocks.

## Versioning
No versioning; single deploy. Changing a field = update models.py + types.ts + this file in the same commit.
