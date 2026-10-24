# 09 Build plan — MVP tonight (Fri Oct 23 → Sun Oct 25)

Rule: vertical slice first. A working ugly pipeline at 9 AM Sat beats a pretty half at 5 PM.

## Gates (Fri 11 PM–2 AM, parallel across teammates). Pass/fail each; record in DIFFICULTIES.md
G1 Twinly: key in .env; `GET /v1/me` ok; Mac-owner voice clone built; `POST /v1/voice/speak` returns audio; measure latency + play it; check `voice_not_set_up` handling. Redeem $20 code.
G2 Decisions: Playground test, then one real `/v1/decisions` call from Python; save raw response to `fixtures/`; note question limits + gating.
G3 Gemma: AI Studio key; `gemma-4-26b-a4b-it` returns valid JSON for the Friday→Monday prompt; measure latency; note rate limit.
G4 ASR: install crisperwhisper, download weights, transcribe the 8 test clips (07); check fillers survive; measure time on MPS/CPU.
G5 Repo: public GitHub, MIT LICENSE, .gitignore (.env, cache, logs, weights), `.env.example`, README stub, DIFFICULTIES.md. ffmpeg installed. Everyone clones & runs `uvicorn`.
**2 AM go/no-go:** G1+G3 mandatory. G4 fail → fallback ASR (07). G2 fail → deterministic guard + banner. G1 fail → pivot to elder-health idea (see 13) ONLY if Twinly Mac can't be made to work by 2 AM.

## Sat
- 9–1 Slice: audio upload → ASR → Gemma (no Decisions/guard) → Twinly → play. Use MOCK flag for parts not ready. Commit.
- 1–6 Decisions pass 1 + 2, guard.py + pytest, fallback ladder, three modes, trace/SSE.
- 6–11 UI polish (diff highlights, decisions bars, stage timeline, approve button, "simulate bad rewrite"), eval harness, pre-render backup audio, `caffeinate` runbook. Sleep ≥6 h.

## Sun
- 9–1 Bugfix, edge cases, 5 consecutive clean demo runs, record video (screen + voiceover; ≤3 min).
- 1–4 README (diagram, setup, licences), DIFFICULTIES.md final, Devpost text, select tracks & challenges, submit by 4 PM. 5 PM is the hard deadline; no changes after submit-ready except typos.
- Night: rehearse 90-second finals pitch; decide who stands at Monday finals (one member physically there).

## Suggested team split (2–5 people, adapt)
A: backend pipeline (asr, rewrite, voice). B: guard + decisions + tests + eval. C: frontend + UX. D: Twinly Mac ops (is the key owner; keeps Mac awake), video, Devpost. E: pitch/README/ethics framing.
If solo/2: skip eval harness polish and compare-modes first.

## Cut list (in order if behind)
1. compare-modes view 2. per-sentence Decisions 3. SSE (poll `/api/jobs/{id}` instead) 4. iMessage voice note 5. Presenter mode 6. intended-mode reference.
NEVER cut: guard deterministic checks, approval step, trace panel, pre-rendered backup audio.

## Commit discipline
Small commits, message `stage: what`. Branch `main` only unless >3 devs; pull --rebase before push. Tag `demo-ready` when 5/5 runs pass.

## Time-boxing
20-min cap on any single blocker → fallback in 13, log in DIFFICULTIES.md, move on.

## Definition of done (MVP)
Canonical utterance: record → text → edits shown → guard pass → approve → hear own voice, 5/5 runs, from a cold server start in <60 s.
