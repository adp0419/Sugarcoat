# PROGRESS

Branch `mvp`. Each terminal edits only its own section (use Edit, never Write). Tick with a timestamp.

Phases: 0 skeleton -> 1 MOCK + ASR + guard basics + UI skeleton -> 2 rewrite + voice + decide + timeline/diff UI -> 3 orchestrator/SSE/fallback + panels + approve/playback -> 4 integrate on real APIs -> 5 harden (README, eval, Makefile)

## Status

| Terminal | Owner files | % done | Current task |
|----------|-------------|--------|--------------|
| T1 core | backend/models.py, config.py, main.py, asr.py, rewrite.py, __init__.py, fixtures/, requirements.txt, Makefile, .env.example, PROGRESS.md | 80% | R1 done. R2 (stage deadlines, job watchdog, `make smoke`) not in git log yet as of 00:51; real Gemma still failing (401/500/slow) |
| T2 guard/decide/voice | backend/guard.py, decide.py, voice.py, split.py, tests/, eval/ | 95% | R3 7/7 done: G1 verified via /api/speak, real-voice backup clip, eval/RESULTS.md, docs, release check. Still blocked: G2 (OpenAI 429 no credits) |
| T3 frontend | frontend/, README.md, DIFFICULTIES.md, docs/RUNBOOK.md | 85% | R2: watchdog, plain-English fallbacks, speak errors, names check done + tested; screenshots, RUNBOOK, README next |

## T1 core backend + contract
- [x] 0  PROGRESS.md (2026-10-23)
- [x] 0  models.py, config.py, main.py skeleton + stubs (guard/decide/voice signatures) (2026-10-23)
- [x] 1  fixtures/ + MOCK code paths (2026-10-23 23:45)
- [x] 1  ffmpeg convert + asr.py (CrisperWhisper) - weights downloaded, not yet run on real audio (2026-10-23 23:50)
- [x] 2  rewrite.py - minimal rung tested; Gemma call BLOCKED: GEMINI_API_KEY gives 401 (see DIFFICULTIES.md)
- [x] 3  orchestrator: /api/process, job store, SSE + polling, trace, fallback ladder (2026-10-23, MOCK tested)
- [x] 3  /api/rewrite, /api/speak, /api/audio, error codes, 10 MB cap (2026-10-23, MOCK tested)
- [x] 4  integrate T2 guard/decide/voice - real run: ASR 2.1 s -> decide -> rewrite -> guard in 2.9 s total; guard correctly blocked Friday; ladder ended at `original` because Gemma 401 + Decisions 429 (2026-10-23)
- [x] 5  Makefile, pinned requirements.txt, .env.example (2026-10-23)

### T1 Round 3
- [x] R3.1 POST /api/live: real + MOCK, busy lock, final-ASR priority, 45 s / 10 MB caps, audio never stored; 11 tests. Medians 1.25/1.48/1.88/4.05 s for 5/10/20/40 s audio (no word timestamps); client interval 3 s, one in flight (docs/md/10) (2026-10-24 10:35)
- [x] R3.2 deterministic self-correction in the fallback rung (natural/presenter): 38 tests (13 inline, 6 restart markers, 10 false positives, canonical + user backtrack pass guard.check_rules), note `Self-corrections fixed by rules (AI editor unavailable)` (2026-10-24 10:28)
- [x] R3.3 Gemini 401/402/403 + Decisions credit errors: no retry (402 job now ends in <2 s), health `no_credits`/`auth_error` from last real call (persisted in cache/provider_status.json; free models.get passes on a no-credit key, verified) (2026-10-24 10:28)
- [x] R3.4 `make smoke` (scripts/smoke.py; N, BASE, SPEAK=1; exits 1 on failure or a run > 60 s) (2026-10-24 10:35)
- [x] R3.5 real e2e on :8010 (:8000 held by a server not started by T1): smoke 5/5, wall 2.0-3.5 s, rung=minimal, guard PASS, Friday->Monday fixed by rules; SPEAK=1: 4.0 s audio in 5.2 s, audio/mp4 ok (2026-10-24 10:35)
- [x] R3.6 cold start to asr_loaded 4-5 s; no keys/audio in logs, transformers/crisperwhisper chatter silenced; 415 unsupported_media, 422 for undecodable audio (2026-10-24 10:35)

## T2 guard / decide / voice
- [x] 1  guard.py deterministic checks + unit tests (42 cases; `check_rules` sync, `check` async contract wrapper) (2026-10-23 23:46)
- [x] 2  decide.py (analyze + verify, 15 tests) (2026-10-23 23:52). G2 PARTIAL: request schema + 400-question limit verified live, but key has no credits (429), so success response shape unverified; offline path verified live
- [x] 2  split.py (sentences + <=550 chunk packer) (2026-10-23 23:50)
- [x] 2  voice.py client + 20 tests + MOCK path (2026-10-23 23:50). G1 PARTIAL: real call returns voice_not_set_up; Mac owner must Build my clone, then re-run `python -m backend.voice "Hello, this is a test."` once
- [x] 3  guard Decisions verifier pass: `guard.check` runs rules + `decide.verify` in parallel, offline degrade (5 combined tests) (2026-10-23 23:55)
- [x] 5  eval/utterances.json (8 cases) + eval/run_eval.py, `--offline` works (2026-10-23 23:53)
- [x] 4  G1 Twinly verified on real API 2026-10-24 (round 3); G2 Decisions still 429 no credits

### T2 Round 2
- [x] R2-1 voice_starting-in-200-job fix committed + tests (2026-10-24 00:35)
- [x] R2-2 G1 real audio: DONE in round 3 (R3-1). Was BLOCKED, voice engine `voice_starting` (2 real POSTs used, 3 left); user must quit+reopen Twinly. Raw capture saved; retry loop now fits the 60 s cap (2026-10-24 00:45)
- [ ] R2-3 G2 real Decisions: BLOCKED, still 429 no credits; added `decide.health()` real probe (2026-10-24 00:46)
- [x] R2-4 guard vs realistic rewrites: 61-case corpus, FP 4/37 -> 0/36, FN 5/30 -> 3/31 (n=67) (2026-10-24 00:48)
- [x] R2-5 deadlines: analyze 15 s, verify 10 s, guard never raises; voice-identity cache + spend-cap tests (2026-10-24 00:46)
- [ ] R2-6 eval/RESULTS.md from a real run (running)

### T2 Round 3 (real-call budget: 15 lines for ALL terminals; used: 10 = 9 by T2 + 1 by another terminal at 10:33; 5 left. Check logs/spend.json before any SPEAK=1)
- [x] R3-1 G1 DONE via /api/speak (MOCK=0, :8001): 1 chunk 68 chars 5.3 s; 3 chunks (507/529/134 chars) 28.6 s, in order (ASR-checked), 57 s audio; repeat = cache hit 10 ms, 0 spend; 3 concurrent requests (2 identical) = 2 lines, serialised; every file AAC 24 kHz mono (ffprobe). Render 4.2-14.1 s per chunk. fixtures/real_twinly_speak_ok.json (2026-10-24 10:33)
- [x] R3-2 fixtures/backup_demo.m4a = canonical line in the owner's cloned voice (3.84 s, ASR: "Our meeting will take place on Monday at five PM. Everyone should attend."); MOCK /api/speak + /api/audio/backup_demo.m4a and voice MOCK cache copy both serve it (stale copies refreshed) (2026-10-24 10:35). For T1: mock.speak still says seconds=3.0 (real 3.84); fixtures/README.md still calls it a tone
- [x] R3-3 voice.py from real runs: 2 concurrent jobs crash Twinly's MLX engine -> one at a time; voice_failed re-posted once; identical chunks share one render; render survives the 60 s cap (paid audio lands in cache); per-chunk latency log + redacted last ok/fail body in logs/ (+6 tests) (2026-10-24 10:40)
- [x] R3-4 guard: 3 known FNs fixed (dropped phrase, added list item, reordered roles) + dropped condition + "let me rephrase" marker; 13 new held-out cases (before the condition rule: 0/8 FP, 2/5 FN); corpus n=80: FP 0/44, FN 1/36 (ho_role_swap); T1 self-correction tests pass check_rules (2026-10-24 10:45)
- [x] R3-5 eval/RESULTS.md: text eval n=24 on real keys (Gemma 402 + Decisions 429 -> every output from the deterministic rung: minimal 22, original 2), 3 real /api/process audio runs (ready, guard pass, 2.0-3.1 s), guard corpus n=80 FP 0/44 FN 1/36, Twinly latency table n=8 (2026-10-24 10:50). For T1: rewrite.minimal leaves phrase repeats ("I want to I want to"); trace marks decide ok + guard "deterministic+decisions" while both AI services are offline
- [x] R3-6 README (macOS 26+ requirement + reason, real eval summary, frontier table, ethics/privacy/licence/limitations; all linked files checked to exist), DIFFICULTIES round 3 (metallib error + how found, concurrent-job crash, Gemini 402, guard), RUNBOOK (engine /health, make smoke, backup audio, per-stage failures), docs/DEVPOST.md draft (2026-10-24 11:05). For T3: README links docs/demo.gif + screenshots ready, fallback-minimal, guard-blocked, names-check, playing, speak-twinly-offline (.png); tell T2 if the redesign renames them. DIFFICULTIES T3 R1 entry still calls backup_demo.m4a a tone
- [x] R3-7 release check: secret grep tree + full history clean (only the public Twinly example mock key in docs/md/04), .env never tracked, .env.example keys blank, LICENSE MIT, largest blob docs/demo.gif 2.1 MB; submission checklist with done/not done in docs/RUNBOOK.md; `make test` 274 passed, 1 xfailed; not pushed, visibility unchanged (2026-10-24 11:05)

## T3 frontend
- [x] 1  frontend/ skeleton (index.html, app.js, style) + record/mode/terms/demo (2026-10-23, offline mock toggle; real server not yet tried)
- [x] T3-cp2 stage timeline, SSE + 800 ms polling fallback (2026-10-23)
- [x] 2  side-by-side transcripts + LCS diff with reason chips (2026-10-23)
- [x] T3-cp4 decisions panel, guard panel, trace panel (2026-10-23)
- [x] 3  approve + chained playback, edit re-check, simulate bad rewrite, all UI states (2026-10-23, verified in headless Chrome against offline mock; real server pending)
- [x] 4  integrated on real backend in MOCK=1 (port 8003): full flow + keyboard-only run pass in headless Chrome (2026-10-23); real-API run pending
- [x] 5  Simulate bad rewrite, README + DIFFICULTIES drafted (2026-10-23); TODO: demo GIF/screenshots, eval table, frontier-table difficulties, real-API run

### T3 Round 2
- [x] R2-1 client watchdog: 15 s silence / 2x stage budget warning, live elapsed seconds, "Use text without AI edit" + "Try again", 60 s hard stop; every fetch has a deadline (2026-10-24 00:51)
- [x] R2-2 plain-English fallbacks: rung box says what was and wasn't changed and why, job.notes mapped, trace rows explain 401/429/500/timeout with raw error in details (2026-10-24 00:51)
- [x] R2-3 speak errors: voice_starting (also when sent as code `internal`), voice_not_set_up, twinly_offline, rate_limited, job_unverified, approval, timeout -> message + fix steps; job_unverified locks speak for that job (2026-10-24 00:51)
- [x] R2-4 names: prominent "Names and special words" field (remembered per browser), Names check panel (heard / misheard as X / kept / fixed) with one-click fix; no backend change (2026-10-24 00:51)
- [x] R2-5a verification harness: frontend/e2e/scenario_server.py (misbehaving fake backend) + e2e.py (Playwright, fake mic); 53/53 checks incl. keyboard-only and 18 px / 4.5:1 contrast audit, light + dark (2026-10-24 00:51)
- [x] R2-5b 11 screenshots in docs/screenshots/ + docs/demo.gif (18 s, MOCK=1 data) generated by `e2e.py gif` (2026-10-24 01:00)
- [x] R2-6 docs/RUNBOOK.md one-page demo-day checklist (2026-10-24 01:00)
- [ ] R2-7 README: eval (needs eval/RESULTS.md from T2), frontier difficulties, screenshots
- [ ] R2-8 DIFFICULTIES.md T3 section

### T3 Round 3 (frontend redesign)
- [ ] R3-1 design system: light/white + one blue accent, tokens in :root (color, 8 px spacing, radius, shadow, type), SVG icon sprite, no dark mode
- [ ] R3-2 3-step layout (1 Speak / 2 Review / 3 Hear it) always visible; status popover in header (incl. no_credits / auth_error)
- [ ] R3-3 Speak: big record button + 45 s ring, live level meter (AnalyserNode, reduced-motion aware), live transcript via POST /api/live (hidden on 404), demo clip, names field, first-run hint
- [ ] R3-4 processing line (hear -> analyse -> edit -> check) + restyled watchdog; Review: inline diff with reasons, compare toggle, editable text, one meaning-check line, "How this was made" panel
- [ ] R3-5 Hear it: speak button with disabled reason, custom player (progress, replay, download, synthetic label), inline speak errors with fix steps
- [ ] R3-6 e2e rewritten: happy path with fake mic + live transcript, all R2 failure paths, keyboard-only, 16 px / 4.5:1 / 3:1 audit, 1280x720 + 200% zoom
- [ ] R3-7 screenshots + demo.gif regenerated from MOCK; one real-server screenshot; list for T2
