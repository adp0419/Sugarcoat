# 18 Stage latency

Stage mode speaks one sentence at a time. The clock that matters is the gap from the end of the sentence the person just said to the first moment of cloned audio. A click on Approve is not part of that gap: `consent=1` on `POST /api/stage/segment` enqueues the render in the same request that ran ASR, the deterministic rewrite, and the rules-only guard.

Measured baseline (2026-10-24, one short sentence, Gemma 402, Decisions 429, Twinly quality model). Source: PROGRESS.md round 4 and `eval/RESULTS.md` section 4.

| Piece | Baseline | What it is |
|---|---|---|
| Pause / cut | 1.2 s | The page waits to be sure the sentence has ended |
| Process | 2.0 s | `/api/process` p50. With `fast=1` the same clip was 1.51 s, almost all ASR |
| Render | 5.9 s | One real `/api/speak/async` of a 44-character line (2.7 s of audio) |
| End of sentence → audio | **9.1 s** | 1.2 + 2.0 + 5.9. Upload-to-playable without the pause was 7.9 s |

That is inside a 12 s ceiling and outside the 5–8 s range we want on stage. The render is most of it.

## Target

| Piece | Target | How |
|---|---|---|
| Cut | 0.5–0.9 s | Cut on a short clause pause instead of a 1.2 s end-of-thought pause |
| Process | ≤ 1.5 s | This segment only (not the whole recording), deterministic rewrite, rules-only guard, no Gemma and no Decisions |
| Render | ~2 s if the fast model is available, else ~6 s | Quality model is what `/v1/voice/speak` uses today. The local engine also has a fast model (~1.5× realtime, ~1 s to first audio). The public API has no documented way to select it |
| End of sentence → audio | **5–8 s**, about **5 s** if the fast model can be requested | 0.5–0.9 + ~1.5 + render. No approve click |
| Queue | hidden when sentences are longer than the render | One Twinly render at a time. The next sentence's ASR runs while the previous line renders |

`make bench-stage` posts fixture clips to `/api/stage/segment` at real-time pace with `consent=0` and fills this table. It does not call Twinly. Render p50/p90 come from `logs/twinly_renders.jsonl` (successful rows, ≤120 characters). The end-of-sentence estimate is `cut + server total + that render`.

First run, same day, real ASR, model already warm, two one-sentence fixtures, no speak: server total p50 **1.37 s** (ASR 1.33 s, rewrite 0 ms, guard 13 ms). With the short-line render p50 of 5.30 s, end of sentence → audio is **7.2 s** at a 0.5 s cut and **7.6 s** at a 0.9 s cut. Rows are in `eval/RESULTS.md` under "Stage latency". Queue wait was 0 because neither file contained a second sentence.

## Levers

1. **Clause cuts (0.5–0.9 s instead of 1.2 s).** Split where the speaker pauses between clauses. A shorter wait detects the end sooner and also makes each ASR clip shorter. The bench uses `ffmpeg silencedetect` for this split; a file with no gap stays one segment.
2. **Segment-only ASR.** Live drafts re-transcribe the whole recording and get slower as it grows (1.25 s at 5 s of audio, 4.05 s at 40 s). A stage segment is one sentence, so ASR stays near the 1.5 s `fast=1` number instead of climbing.
3. **Deterministic path.** Gemma is skipped (it is out of credits, and when it answers it takes ~16 s). The rewrite is `rewrite.minimal` (fillers, repeats, same-kind self-corrections). The guard is `check_rules` only. That is the path the Saturday eval actually measured.
4. **Auto-enqueue.** If the guard passes and `consent=1`, the response includes a `speak_id` and the render is already in the FIFO. The old flow waited for Approve, which is another human reaction on top of the 9.1 s.
5. **Pipelining.** Segment N+1 is recorded and transcribed while segment N renders. Twinly still renders one line at a time (two at once crashed the engine). Queue wait shows up in the bench when a render runs longer than the next sentence.
6. **Full duplex with headphones.** Speakers force half-duplex: the mic hears the cloned voice if recording stays open. Headphones on the Mac, with the iPhone as the mic, let the next sentence start while the previous line plays. Setup is in `docs/RUNBOOK.md`.
7. **Twinly fast model, if the API accepts it.** Local engine health (`http://127.0.0.1:4807/health`) reports `fast` and `quality` separately. Our renders match quality (~0.5–0.75× realtime), not fast (~1.5×). A 2.7 s line at fast speed is roughly 2 s plus relay overhead, which is what moves 9.1 s toward 5 s. We have not sent `fast: true` on `/v1/voice/speak`; it is not in the documented body, and a rejected call can still spend a line.

## Why we do not speak predicted words

The audio that gets spoken is the segment the person already finished, rewritten by rules, and accepted by the guard. `consent=1` is the permission to enqueue that text. A held segment (`held: true`, `speak_id: null`) is silent until `POST /api/speak/async` with the text someone approved.

Speaking a model's guess of the rest of the sentence would play words the person has not said and has not approved. The guard cannot check a prediction against a verbatim that does not exist yet, and the Friday/Monday case is exactly the failure that prediction would ship: the superseded day, said out loud, in their voice. Stage mode saves the approve click. It does not skip the check.
