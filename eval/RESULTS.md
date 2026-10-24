# VoiceFlow eval results

Measured 2026-10-24 (Gator Hack V, Saturday morning) on a MacBook (Apple silicon, macOS 27.0.1, Twinly 4.2.1).
Every number below comes from a script run; nothing was typed in by hand. Raw rows: `eval/results_2026-10-24_text.json`,
`eval/results_2026-10-24_audio.json`, `fixtures/real_twinly_speak_ok.json`.

## What was online and what was not

| Stage | Service | State during these runs |
|---|---|---|
| ASR | CrisperWhisper turbo, local (MPS) | **online**, real |
| Analysis / AI verifier | OpenAI Decisions API (`gpt-6-luna`) | **offline**: key returns `429` no credits. Rewrites were checked by the deterministic guard only |
| AI edit | Gemma 4 (`gemma-4-26b-a4b-it`) via the Gemini API | **offline**: every call returned `402 RESOURCE_EXHAUSTED` (prepayment credits depleted) |
| Fallback edit | deterministic rung (`rewrite.minimal`: fillers, repeats, rule-based self-corrections) | **online**: produced every output below |
| Meaning guard | `guard.check_rules` (deterministic) | **online** |
| Voice | Twinly `POST /v1/voice/speak`, owner's cloned voice | **online**, real paid calls |

So these results measure the **fallback ladder and the guard**, not Gemma's editing quality. The rung column says which
step produced each output: `full`/`retry` = Gemma (none here), `minimal` = deterministic rung, `original` = unchanged text
because the deterministic rung's output also failed the guard.

## 1. Text eval: 8 utterances x 3 modes (n=24)

`python eval/run_eval.py --json ... --md ...` with the real keys (text-only, no ASR). Utterances: `eval/utterances.json`
(canonical self-correction, hedges, negations, numbers, already fluent, number self-correction, stutter, names + quantifiers).

| id | mode | rung | guard | verifier | decisions | must_keep ok | must_drop ok | words in→out | ms |
|---|---|---|---|---|---|---|---|---|---|
| canonical | minimal | original | pass | offline | off | yes | NO | 28→28 | 426 |
| canonical | natural | minimal | pass | offline | off | yes | yes | 28→23 | 277 |
| canonical | presenter | minimal | pass | offline | off | yes | yes | 28→23 | 282 |
| hedges | minimal | minimal | pass | offline | off | yes | yes | 12→10 | 277 |
| hedges | natural | minimal | pass | offline | off | yes | yes | 12→10 | 254 |
| hedges | presenter | minimal | pass | offline | off | yes | yes | 12→10 | 253 |
| negations | minimal | minimal | pass | offline | off | yes | yes | 18→17 | 277 |
| negations | natural | minimal | pass | offline | off | yes | yes | 18→17 | 248 |
| negations | presenter | minimal | pass | offline | off | yes | yes | 18→17 | 244 |
| numbers_heavy | minimal | minimal | pass | offline | off | yes | yes | 16→13 | 269 |
| numbers_heavy | natural | minimal | pass | offline | off | yes | yes | 16→13 | 321 |
| numbers_heavy | presenter | minimal | pass | offline | off | yes | yes | 16→13 | 249 |
| already_fluent | minimal | minimal | pass | offline | off | yes | yes | 9→9 | 281 |
| already_fluent | natural | minimal | pass | offline | off | yes | yes | 9→9 | 280 |
| already_fluent | presenter | minimal | pass | offline | off | yes | yes | 9→9 | 256 |
| number_self_correction | minimal | original | pass | offline | off | yes | NO | 16→16 | 265 |
| number_self_correction | natural | minimal | pass | offline | off | yes | yes | 16→9 | 286 |
| number_self_correction | presenter | minimal | pass | offline | off | yes | yes | 16→9 | 233 |
| stutter_false_start | minimal | minimal | pass | offline | off | yes | yes | 18→15 | 252 |
| stutter_false_start | natural | minimal | pass | offline | off | yes | yes | 18→15 | 261 |
| stutter_false_start | presenter | minimal | pass | offline | off | yes | yes | 18→15 | 255 |
| names_quantifiers | minimal | minimal | pass | offline | off | yes | yes | 22→20 | 240 |
| names_quantifiers | natural | minimal | pass | offline | off | yes | yes | 22→20 | 255 |
| names_quantifiers | presenter | minimal | pass | offline | off | yes | yes | 22→20 | 258 |

n=24 runs (8 utterances x 3 modes), offline=False
- meaning preserved without fallback (guard pass, rung=full): 0/24 = 0%
- fell back to minimal/original: 24/24 = 100%
- must_keep satisfied: 24/24; must_drop satisfied: 22/24
- filler reduction: 36→4 (89%)
- avg latency: 270 ms
- note: AI verifier offline for some/all runs; those results are deterministic-guard only
- rungs: full 0, retry 0, minimal 22, original 2
- rewrite errors seen: GemmaUnavailable: Gemini key has no credits (402) - add billing in AI Studio

Reading it:
- The 2 `must_drop` misses are both **Minimal** mode on utterances with a self-correction ("Friday—actually, sorry, Monday").
  Minimal mode only removes fillers, so its output still says "Friday"; the guard bans a superseded value, so the ladder
  fell back to the original text. That is the designed behaviour (never speak the wrong day), but it means Minimal is the
  wrong mode for self-corrections. Natural and Presenter fixed both with the rule-based self-correction.
- Remaining fillers (4) are all in those two unchanged originals.
- Weak output the checks do not catch: `stutter_false_start` comes out as "I want to I want to tell everyone that the
  deadline moved to April 5th." The deterministic rung collapses single-word repeats but not a repeated phrase. Gemma
  would fix it; with Gemma offline it is spoken as is (meaning intact, not fluent).
- Natural and Presenter give identical output here because Gemma was offline; the deterministic rung has no presenter style.

## 2. Real audio through the real server (n=3)

`POST /api/process` on a `MOCK=0` server, clip `frontend/demo-clip.m4a` (macOS `say` voice reading a messy announcement,
not a person), mode Natural. Same clip 3 times; run 0 is the first after the ASR model loaded.

| run | status | rung | guard | ASR ms | total ms |
|---|---|---|---|---|---|
| 0 | ready | minimal | pass | 2734 | 3121 |
| 1 | ready | minimal | pass | 1594 | 1987 |
| 2 | ready | minimal | pass | 1624 | 2021 |

- Verbatim (CrisperWhisper kept the fillers and the false start): "So um the team meeting is on uh Friday at five PM no wait sorry Monday at five PM an- and everyone should bring their laptops."
- Output: "So the team meeting is on Monday at five PM and everyone should bring their laptops."
- Trace per run: convert (ffmpeg) -> asr -> decide (unavailable, ~90 ms) -> Gemma rewrite failed 402 (~160 ms, not retried) ->
  deterministic rewrite -> guard (~105 ms). Job notes shown to the user: "AI editor unavailable: Gemini key has no credits
  (402)", "AI verifier offline - deterministic checks only", "Self-corrections fixed by rules (AI editor unavailable)".

## 3. Meaning guard: labelled corpus (n=80)

`python eval/guard_eval.py` on `eval/guard_cases.json` (hand-written Gemma-style rewrites, good and bad) plus identity
rewrites of the eval utterances. False positive = a good rewrite blocked; false negative = a meaning change let through.

| Round | n | False positives | False negatives |
|---|---|---|---|
| Round 2 start | 67 | 4/37 | 5/30 |
| Round 2 end (00:48) | 67 | 0/36 | 3/31 |
| Round 3, 13 new held-out cases, before any change for them | 13 | 0/8 | 2/5 |
| Round 3 final (10:45) | 80 | **0/44** | **1/36** |

Round 3 added rules for a dropped multi-word phrase, a new item added to a list, content words reordered so roles swap,
and a dropped condition (`if/unless/except`). The held-out row is the honest one: those 13 cases were written before the
rules were tuned on them, and 2 of 5 bad rewrites got through (one was then fixed by the condition rule). The remaining
false negative, `ho_role_swap` ("the marketing team will review the design team's proposal" -> design/marketing swapped),
uses the same words in the same order; no deterministic check sees it. That is what the Decisions verifier is for, and it
was offline. The corpus is small and written by us, so treat 0/44 as "no known false positives", not a rate.

## 4. Twinly voice latency (real calls, n=8 renders)

Through `POST /api/speak` on the real server. `render s` = Twinly wall time for one chunk (POST `?wait=25` returned
HTTP 200 with the finished job every time, never 202). Durations checked with `ffprobe` (AAC, 24 kHz, mono, m4a).

| what | chars | render s | audio s | realtime factor |
|---|---|---|---|---|
| 1-chunk line | 68 | 5.3 | 2.9 | 1.81x |
| 3-chunk text, chunk 1 | 507 | 14.1 | 24.6 | 0.57x |
| 3-chunk text, chunk 2 | 529 | 14.4 | 25.7 | 0.56x |
| 3-chunk text, chunk 3 (rendered alone after a crash, see below) | 134 | 10.6 | 7.1 | 1.50x |
| concurrent test, line A (2 identical requests, 1 render) | 60 | 5.3 | 3.1 | 1.70x |
| concurrent test, line B (queued 5.3 s) | 63 | 4.2 | 3.7 | 1.12x |
| backup demo line | 70 | 7.6 | 3.8 | 1.99x |

- 3-chunk text (1,172 chars, 57 s of audio): **28.6 s** end to end, chunks in order (each file transcribed back with
  CrisperWhisper: word similarity 0.98 / 0.98 / 0.90 to its chunk). Repeat request: all 3 chunks from cache in **10 ms**, 0 spend.
- Short lines (60-70 chars) take 4-8 s; long chunks render faster than real time (~0.57x).
- One more render (84 chars, 5.2 s) came from another terminal's smoke run in the same window and is not in the table.
- **Failure seen:** the first 3-chunk attempt sent 2 chunks at once (Twinly documents 2 concurrent Mac jobs). Both failed
  in ~2 s; Twinly's voice engine log showed `libc++abi: terminating due to uncaught exception of type std::runtime_error:
  There is no Stream(gpu, 12) in current thread.` and the engine restarted. voice.py now renders one chunk at a time and
  re-posts a `voice_failed` job once. After the change, 3 concurrent requests rendered without a crash.
- Cost: 10 real lines this round across all terminals (~$1.00), including 2 failed jobs.

## What these numbers do not show

- Gemma 4's editing quality and the Decisions verifier: both were offline (credits). With credits, rerun `make eval`.
- Real human speech: the audio runs use a synthetic `say` clip. Teammates' "sounds like me" ratings are not collected yet.
- Long texts: a 2,400-char text is 5 chunks at ~14 s each, which is longer than the server's 60 s speak cap. The first
  request times out, the renders keep going in the background, and the retry plays from cache without paying again.


## Optimization follow-up (2026-10-24)

See [the optimization report](../docs/OPTIMIZATION_2026-10-24.md) for reproducible comparisons on `rohit-optimize`: controlled pipeline **1.56× faster (35.7% less time)**, first-chunk backend availability **2.99× earlier**, and modeled live-ASR input work **73.3% lower**. These are not live paid-provider speedups. Offline unsafe approvals fell **12/48 → 0/48** on the expanded set, while valid auto-approval coverage fell **47/47 → 10/47** because substantive changes now require an available independent verifier. The existing historical rows above are unchanged.
