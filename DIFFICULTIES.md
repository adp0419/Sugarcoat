# Difficulties

Problems we hit, what we tried, and what we did. Each terminal appends only under its own heading.

## Terminal 1 — backend / pipeline

- **Gemini key rejected (401 UNAUTHENTICATED, ACCESS_TOKEN_TYPE_UNSUPPORTED)** — 2026-10-23. `GEMINI_API_KEY` in `.env` starts with `AQ.` (53 chars); AI Studio API keys start with `AIza`, so this looks like an OAuth-style token. Fix: create a key at aistudio.google.com/apikey. Until then real-mode rewrite falls to the deterministic minimal rung; MOCK=1 covers UI work.
- **No python3.11 / ffmpeg on the machine** — used a 3.13 venv (all deps install fine) and `brew install ffmpeg`.

## Terminal 2 — ASR / guard / eval

- **Twinly G1: `voice_not_set_up`, no audio yet** — 2026-10-23. `GET /v1/me` is 200 in ~1.8 s and shows `mac.online:true` (app 4.2), but `mac.setup.voice` is a how-to string ("Record a voice: Twinly, Voice, then Build my clone") instead of `true`. The one real `POST /v1/voice/speak?wait=25` ("Hello, this is a test.") returned in 2.8 s with HTTP **200** and a job body `status:"failed"`, `error.code:"voice_not_set_up"` (not a 4xx), so errors can arrive inside a 200 job. Fix needs the Mac owner: Twinly app > Voice > Build my clone. Not retried (no credit burned on a known failure). Audio playback and real latency are still unverified until the clone exists. Shapes saved in `fixtures/real_twinly_me.json`, `fixtures/real_twinly_speak.json`; `voice.health()` reads `me.mac.setup.voice === true` as `voice_ready`.

- **Decisions G2: OpenAI key has zero credits (`429 credit_balance_exhausted`)** — 2026-10-23. `POST /v1/decisions` with `gpt-6-luna` returns `429 insufficient_quota` "You have no credits remaining", so no successful response was captured and the answer shape (`answers[].probability` / `choice`) is still the docs' guess. What we did verify with free validation errors (no billing): `GET /v1/models` lists `gpt-6-luna` for this key (so no model gating); `/v1/decisions` exists (a bogus path is 404, ours is 400 on bad bodies); question `type` is one of `predicate | choice | score`; predicate needs `instructions`; choice needs `choices` as objects (`value`, `description`); score needs `levels`; **max 400 questions per call** (11 accepted, 401 rejected), which settles the 10-vs-400 conflict in docs/md/05. Fix needs a human: add credits at platform.openai.com/settings/organization/billing, then re-run `python -m backend.decide "..."` once and save the response to `fixtures/real_decisions_*.json`. Until then `decide.analyze` returns `available=False` with the reason (verified live), and the guard runs deterministic-only with verifier `offline`. Raw error in `fixtures/real_decisions_429_no_credits.json`.
- **Guard design choice: contract says `check()` is async and returns pydantic `GuardResult`** — the pure rules live in sync `check_rules()` (42 tests, no network) and `check()` wraps them, so tests stay instant.

## Terminal 3 — frontend / docs

- **Browser recording vs. playback gestures** — 2026-10-23. Chained `<audio>` playback after an async speak request can be blocked by autoplay rules. Fix: one shared `<audio>` element is primed with a silent clip inside the Approve click, then its `src` is swapped per chunk.
- **Playback state overwrote recording state** — a chunk finishing after the user pressed Record set the UI back to "playing". Fix: cancel chained playback (generation counter) at the start of `startRecording`, before the microphone opens. Found with a headless-Chrome run and a fake microphone.
- **`display:flex` beat the `hidden` attribute** — the empty error box and override checkbox were visible on a clean page. Fix: `[hidden] { display: none !important }`. Found from a screenshot, not from tests.
- **Backend edit reasons are codes** (`restructure`, `self_correction`), not sentences — mapped to plain English in the UI rather than changing the contract.
- **No real demo clip** — `fixtures/backup_demo.m4a` is a placeholder tone, which real ASR would reject as no speech. The "Use demo clip" button uses `frontend/demo-clip.m4a`, generated with macOS `say` reading the canonical announcement (a synthetic voice, not a person). Replace it with a real recording of the demo speaker before finals.
- **Twinly offline UX ambiguity** — docs/md/10 says Record is blocked when Twinly is offline, docs/md/11 says text-only mode. We kept Record enabled and switched only speaking off, so the cleaned-up text is still useful.

