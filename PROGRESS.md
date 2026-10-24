# PROGRESS

Branch `mvp`. Each terminal edits only its own section (use Edit, never Write). Tick with a timestamp.

Phases: 0 skeleton -> 1 MOCK + ASR + guard basics + UI skeleton -> 2 rewrite + voice + decide + timeline/diff UI -> 3 orchestrator/SSE/fallback + panels + approve/playback -> 4 integrate on real APIs -> 5 harden (README, eval, Makefile)

## Status

| Terminal | Owner files | % done | Current task |
|----------|-------------|--------|--------------|
| T1 core | backend/models.py, config.py, main.py, asr.py, rewrite.py, __init__.py, fixtures/, requirements.txt, Makefile, .env.example, PROGRESS.md | 5% | Phase 0 skeleton |
| T2 guard/decide/voice | backend/guard.py, decide.py, voice.py, tests/ | 0% | waiting on T1 contract |
| T3 frontend | frontend/ | 0% | waiting on T1 contract |

## T1 core backend + contract
- [ ] 0  PROGRESS.md
- [ ] 0  models.py, config.py, main.py skeleton + stubs (guard/decide/voice signatures)
- [ ] 1  fixtures/ + MOCK code paths
- [ ] 1  ffmpeg convert + asr.py (CrisperWhisper)
- [ ] 2  rewrite.py (Gemma 4 via Gemini API, 3 modes, minimal-filler rung)
- [ ] 3  orchestrator: /api/process, job store, SSE + polling, trace, fallback ladder
- [ ] 3  /api/rewrite, /api/speak, /api/audio, error codes, 10 MB cap
- [ ] 4  integrate T2 guard/decide/voice; canonical utterance e2e < 20 s
- [ ] 5  Makefile, pinned requirements.txt, .env.example

## T2 guard / decide / voice
- [ ] 1  guard.py deterministic checks + unit tests (>=25 cases)
- [ ] 2  decide.py (OpenAI Decisions: analysis + per-sentence)
- [ ] 2  voice.py (Twinly speak, chunking, cache)
- [ ] 3  guard Decisions verifier pass (combined verdict)
- [ ] 4  verified on real APIs, fixtures saved
- [ ] 5  eval/ utterances + run_eval.py

## T3 frontend
- [ ] 1  frontend/ skeleton (index.html, app, style) against MOCK=1 server
- [ ] 2  stage timeline + side-by-side transcripts + diff highlight
- [ ] 3  decisions panel, guard panel, approve + playback, SSE with polling fallback
- [ ] 4  integrate on real backend
- [ ] 5  polish, "Simulate bad rewrite" button, README screenshots
