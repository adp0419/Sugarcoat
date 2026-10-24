# PROGRESS

Branch `mvp`. Each terminal edits only its own section (use Edit, never Write). Tick with a timestamp.

Phases: 0 skeleton -> 1 MOCK + ASR + guard basics + UI skeleton -> 2 rewrite + voice + decide + timeline/diff UI -> 3 orchestrator/SSE/fallback + panels + approve/playback -> 4 integrate on real APIs -> 5 harden (README, eval, Makefile)

## Status

| Terminal | Owner files | % done | Current task |
|----------|-------------|--------|--------------|
| T1 core | backend/models.py, config.py, main.py, asr.py, rewrite.py, __init__.py, fixtures/, requirements.txt, Makefile, .env.example, PROGRESS.md | 70% | MOCK=1 serves full contract; next: real ASR run, integrate T2 |
| T2 guard/decide/voice | backend/guard.py, decide.py, voice.py, tests/ | 0% | waiting on T1 contract |
| T3 frontend | frontend/ | 0% | waiting on T1 contract |

## T1 core backend + contract
- [x] 0  PROGRESS.md (2026-10-23)
- [x] 0  models.py, config.py, main.py skeleton + stubs (guard/decide/voice signatures) (2026-10-23)
- [x] 1  fixtures/ + MOCK code paths (2026-10-23 23:45)
- [x] 1  ffmpeg convert + asr.py (CrisperWhisper) - weights downloaded, not yet run on real audio (2026-10-23 23:50)
- [x] 2  rewrite.py - minimal rung tested; Gemma call BLOCKED: GEMINI_API_KEY gives 401 (see DIFFICULTIES.md)
- [x] 3  orchestrator: /api/process, job store, SSE + polling, trace, fallback ladder (2026-10-23, MOCK tested)
- [x] 3  /api/rewrite, /api/speak, /api/audio, error codes, 10 MB cap (2026-10-23, MOCK tested)
- [ ] 4  integrate T2 guard/decide/voice; canonical utterance e2e < 20 s
- [ ] 5  Makefile, pinned requirements.txt, .env.example

## T2 guard / decide / voice
- [x] 1  guard.py deterministic checks + unit tests (42 cases; `check_rules` sync, `check` async contract wrapper) (2026-10-23 23:46)
- [x] 2  decide.py (analyze + verify, 15 tests) (2026-10-23 00:05). G2 PARTIAL: request schema + 400-question limit verified live, but key has no credits (429), so success response shape unverified; offline path verified live
- [x] 2  split.py (sentences + <=550 chunk packer) (2026-10-23 23:50)
- [x] 2  voice.py client + 20 tests + MOCK path (2026-10-23 23:58). G1 PARTIAL: real call returns voice_not_set_up; Mac owner must Build my clone, then re-run `python -m backend.voice "Hello, this is a test."` once
- [ ] 3  guard Decisions verifier pass (combined verdict)
- [ ] 4  verified on real APIs, fixtures saved
- [ ] 5  eval/ utterances + run_eval.py

## T3 frontend
- [x] 1  frontend/ skeleton (index.html, app.js, style) + record/mode/terms/demo (2026-10-23, offline mock toggle; real server not yet tried)
- [x] T3-cp2 stage timeline, SSE + 800 ms polling fallback (2026-10-23)
- [x] 2  side-by-side transcripts + LCS diff with reason chips (2026-10-23)
- [x] T3-cp4 decisions panel, guard panel, trace panel (2026-10-23)
- [x] 3  approve + chained playback, edit re-check, simulate bad rewrite, all UI states (2026-10-23, verified in headless Chrome against offline mock; real server pending)
- [x] 4  integrated on real backend in MOCK=1 (port 8003): full flow + keyboard-only run pass in headless Chrome (2026-10-23); real-API run pending
- [x] 5  Simulate bad rewrite, README + DIFFICULTIES drafted (2026-10-23); TODO: demo GIF/screenshots, eval table, frontier-table difficulties, real-API run
