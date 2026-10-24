# 03 Pipeline (stage contracts)

| # | Stage | In | Out | Budget |
|---|-------|----|-----|--------|
| 0 | Convert | webm blob | 16 kHz mono wav (`ffmpeg -i in -ar 16000 -ac 1 out.wav`) | <0.5 s |
| 1 | ASR | wav | `verbatim: str`, `words[{w,start,end}]`, optional `intended` | 2–6 s |
| 2 | Split | verbatim | `sentences[]` (see below) | ~0 |
| 3 | Decide | verbatim + sentences | `mode`, `per_sentence[{keep:bool, issues[]}]`, `probs` | 1–3 s |
| 4 | Rewrite | verbatim + decisions + mode | `rewrite`, `edits[{from,to,reason}]` | 2–5 s |
| 5 | Guard | verbatim, rewrite | `pass`, `violations[]` | 1–3 s |
| 6 | Approve | rewrite | user clicks (UI) | human |
| 7 | Speak | approved text | audio chunks (m4a/mp4) | ~3 s/chunk |

## Splitting
ASR output has little punctuation. Split on `[.?!]` then on pauses > 0.7 s from word timestamps. Chunks for Twinly: pack sentences up to 550 chars (margin under 600), never split mid-sentence; if one sentence >550, split at commas.

## Self-correction handling (core demo)
"Friday—actually, sorry, Monday" → Decisions flags `self_correction`; Gemma keeps only the corrected value. Guard must treat the *last* stated value as truth: when verbatim contains markers (actually, sorry, I mean, no wait, scratch that), allowed final value = the one after the marker. Details in 08.

## Fallback ladder (guard fail or stage error)
1. Retry rewrite with stricter prompt + listing violated facts (1 retry).
2. Minimal deterministic: regex remove fillers (um, uh, er, ah, you know, like-as-filler), collapse immediate repeats, fix spacing/capitalization.
3. Original verbatim text (flag "no changes made").
UI always shows which rung produced the output.

## Mode semantics
- Minimal: remove fillers/repeats only. Wording unchanged.
- Natural: also fix false starts/self-corrections, light grammar. Same register.
- Presenter: restructure into crisp announcement sentences. Still no new facts.
Decisions picks a *recommended* mode; user may override. Run 3 modes in parallel only on demand ("compare modes"), not by default (rate limits).

## Error semantics
Stage failure never kills the job: record error in trace, take next ladder rung. Only ASR failure or empty transcript is fatal → UI message "Couldn't hear anything, try again" (also trigger if wav RMS is near zero).

## Idempotency
`/api/process` creates new job each call. `/api/speak` keyed by (job_id, text hash); repeat call returns cached audio.

## Latency target
Process (stages 0–5) ≤ 10 s warm; speak ≤ 8 s for demo utterance (2 chunks max, usually 1).
