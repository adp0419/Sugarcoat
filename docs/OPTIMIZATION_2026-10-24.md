# VoiceFlow optimization — 2026-10-24

Reviewed `main` at `bf46239` using `CODE_REVIEW_2026-10-24.md` and `eval/RESULTS.md`, then worked on `rohit-optimize`. FastAPI, vanilla JavaScript, the existing local ASR model, and serialized voice rendering remain. No paid API calls were made. The supplied review file was already untracked and was not edited.

## What changed

- **Remove blocking style analysis.** Auto now selects Natural. Analysis no longer precedes rewriting; independent semantic verification remains a separate step. Light mode performs local hesitation-sound removal without model calls. Recent authentication/credit failures suppress pointless editor attempts for ten minutes.
- **Constrain editing.** Prompts preserve predicates, roles, conditions, quantities and commitments. Automatic model edits must use existing words in their original order; additions and reordering fail the edit budget. Presenter is consequently less stylistically ambitious. Human edits remain possible and go through the verifier. Lexical “Do you know…” and “I mean every word…” survive deterministic cleanup.
- **Fail closed on substantive changes.** Exact text and narrowly defined hesitation removal can pass locally. Other changes need both the deterministic guard and an available, approving independent verifier, including in fast mode. Deterministic failures skip the unnecessary verifier request. If verification is unavailable, automatic rewriting degrades to hesitation removal or the unchanged original. Self-corrections and repetitions may remain rather than being silently resolved without independent verification. The verbatim transcript is retained separately.
- **Bound live ASR work.** Draft requests occur every four seconds and transcribe at most eight seconds. The UI explicitly calls this the latest eight seconds; it does not present a speculative stitched draft as a full transcript. Complete final ASR still runs on the recording. Uploads remain cumulative to preserve browser container headers; conversion and network traffic are not fully incremental.
- **ASR reliability.** Single-flight initialization, actual inference occupancy retained after caller cancellation, bounded waiting for an active live pass before final ASR, distinct conversion paths for WAV uploads, conversion timeout with subprocess reaping, a full-pipeline deadline, and a 45-second decoded-input limit. Legitimate repetition no longer triggers blanket transcript rejection.
- **Approval and revisions.** Every input invalidates the verdict immediately. Responses are scoped to recording, job, text and edit generation. Both speech endpoints require a ready job, matching revision and text, `approved: true`, and explicit `override: true` for a failed/missing verdict. Reset invalidates timers and pending work. Manual takeover cancels the initial pipeline; mode reruns return 202 immediately and are polled to completion.
- **Incremental audio.** The page uses `/api/speak/async`, checks explicit queued/rendering/done/failed states, and appends chunks without replaying prior audio. It handles gaps, partial failure, stale responses and browser autoplay rejection. It does not generate speech until the user presses Speak. A 400 ms poll interval adds up to roughly 400 ms to discovery, excluding HTTP time.
- **Prevent repeat paid submissions.** Sequential rendering stops after the first failed chunk. Account coordination and a provider-endpoint file lock serialize clients sharing the cache. Identical active queue submissions deduplicate. A durable journal is flushed before submission; known upstream jobs reconcile by GET, while unknown outcomes block resubmission across client/process restarts. Accepted failed jobs and ambiguous 503s are no longer automatically re-POSTed. Explicit pre-submission rate-limit/voice-starting responses retain bounded retries.

## Measurements

Raw results: `eval/optimization_before.json`, `eval/optimization_after.json`, `eval/optimization_asr.json`. These complement, rather than replace, the historical results.

| Measure | Before | After | Interpretation |
|---|---:|---:|---|
| Pipeline median, 10 measured runs + 1 warmup | 226.52 ms | 145.55 ms | **1.56× faster; 35.7% less time**, controlled fake-provider delays |
| Three-chunk audio: all-ready vs first-ready median | 301.09 ms | 100.87 ms | **2.99× earlier availability; 66.5% less waiting** at backend, controlled 100 ms/chunk renderer |
| ASR input-duration budget for a 45 s recording | 315 s | at most 84 s | **3.75× less input; 73.3% reduction**, schedule model, not measured inference speed |
| Unsafe auto-approvals with verifier offline | 12/48 | 0/48 | **100% reduction on this labelled set**; not a general accuracy estimate |
| Valid rewrites auto-approved offline | 47/47 | 10/47 | Coverage falls **100% → 21.3%**; the other 37 require verification |

The controlled pipeline injects 40 ms ASR, 80 ms analysis, 60 ms rewriting and 40 ms independent verification. The improvement measures removal of the analysis dependency, not faster model inference. Real benefit depends on actual stage latencies. The speech queue already exposed partial chunks on main; the production UI now consumes them. The first-ready measurement excludes browser polling and autoplay delays, and total rendering throughput is essentially unchanged.

The ASR budget assumes every scheduled tick completes before the next one, and excludes a tick exactly at the stop boundary. Before: 3, 6, …, 42 seconds summed. After: min(8, t) at 4, 8, …, 44 seconds. Real busy-tick skipping reduces both workloads; fixed encoder padding, decoding, and conversion mean the input reduction is not a 3.75× measured ASR speedup.

Safety evaluation uses the existing 80 cases plus 12 review/regression meaning changes and three valid controls (95 total). It measures automatic approval behavior with an unavailable verifier. The new policy abstains on substantive edits; it does not prove the deterministic guard understands every meaning change. The original deterministic-only role-swap gap remains an expected failure. Live model quality and human-speech WER were not measured.

## ASR-native cleanup experiment

The installed CrisperWhisper exposes `intended` and `transcribe_dual`. The first local cached-weight run measured 193,656 ms verbatim and 180,717 ms intended on the existing synthetic demo clip, one sample each: intended was 1.07× faster (6.7% less time), but this is not a usable pipeline speedup because verbatim must still be retained. Intended output still included both Friday and Monday with the correction marker. Dual transcription raised `NotImplementedError: transcribe_dual() requires the ct2 backend`.

These unusually slow observations conflict with the historical 1.6–2.7 second runs. MPS was available and a process sample showed a Metal synchronization wait. The first benchmark called inference from the main thread after model initialization on the worker; its partial results are preserved in `eval/optimization_asr_initial.json`. A follow-up on the production worker took **182,365 ms verbatim and 354,825 ms intended** (one sample each; intended 1.95× slower), again producing the same texts and the same dual-backend error. Switching threads does not explain the slowdown. No ASR mode or runtime was adopted. An alternative runtime needs a fair verbatim-plus-cleanup latency comparison, a human-speech corpus and fact/negation/self-correction checks before adoption.

## Validation and reproduction

- Baseline: `MOCK=1 .venv/bin/python -m pytest -q`: 312 passed, 1 xfailed (15.46 s).
- Updated: `make test`: 347 passed, 1 xfailed, plus 9 Node frontend regression tests. Tests deny real provider HTTP requests.
- `tests/browser_optimization.py`: real headless Chromium against a local MOCK server; first-chunk playback, incremental polling, immediate edit invalidation, reset and no page errors passed. The speech status responses use controlled browser routes, not a paid provider.
- Real ffmpeg conversion/window tests; fake-transport restart/reconciliation, serialization, stop-on-failure and exact-approval tests.
- `node --check frontend/app.js`, Python compilation and `git diff --check`.

Reproduce controlled comparisons (no paid calls):

```sh
mkdir -p /tmp/voiceflow-baseline
git archive main | tar -x -C /tmp/voiceflow-baseline
MOCK=1 .venv/bin/python eval/benchmark_optimization.py --repo /tmp/voiceflow-baseline --out eval/optimization_before.json
MOCK=1 .venv/bin/python eval/benchmark_optimization.py --out eval/optimization_after.json
make test
```

Local model benchmark, cached weights only: `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 MOCK=1 .venv/bin/python eval/benchmark_asr.py --repeats 1`. Browser check: start `MOCK=1 .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8017`, then run `.venv/bin/python tests/browser_optimization.py`.

## Remaining gaps and operational limits

- No paid Gemma/Decisions/Twinly end-to-end latency or accuracy evaluation; no real human speech or production browser/network timing corpus. The observed local ASR slowdown needs investigation before claiming an end-to-end speedup.
- The deterministic guard still has semantic, signed/currency-quantity and OS-dictionary gaps. Automatic substantive edits require independent verification; a deliberate user override can still authorize unverified text.
- This remains a local application. The review's account/session/audio ownership isolation and retention issues are not comprehensively fixed. Do not treat it as ready for a shared multi-user deployment.
- Speech records and jobs are still in memory. The paid-request journal and audio cache survive restarts, but full speech-task history does not. File locks require processes to share a local cache directory; they do not coordinate separate machines. Per-account rate limiting is shared within the event loop, not distributed across processes.
- Unknown paid outcomes require operator reconciliation in Twinly; there is no automated “safe to resend” proof or journal-resolution UI. Never clear a `.request.json` just to retry. A known job can be polled again without POSTing, while an unknown submission deliberately favors avoiding duplicate charges over availability.
- ASR timeout does not kill a running inference thread. Occupancy remains visible and new work is bounded, but a permanently stuck model needs a server restart or future process isolation. Admission limits for all uploads/jobs and retention policies remain future work.
- Rolling drafts can begin mid-word and omit earlier context. Final ASR preserves the full recording, including repetitions and self-corrections. Audio may pause between chunks if rendering falls behind playback.
