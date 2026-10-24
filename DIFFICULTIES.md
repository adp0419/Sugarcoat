# Difficulties

Problems we hit, what we tried, and what we did. Each terminal appends only under its own heading.

## Terminal 1 — backend / pipeline

- **Gemini key rejected (401 UNAUTHENTICATED, ACCESS_TOKEN_TYPE_UNSUPPORTED)** — 2026-10-23. `GEMINI_API_KEY` in `.env` starts with `AQ.` (53 chars); AI Studio API keys start with `AIza`, so this looks like an OAuth-style token. Fix: create a key at aistudio.google.com/apikey. Until then real-mode rewrite falls to the deterministic minimal rung; MOCK=1 covers UI work.
- **No python3.11 / ffmpeg on the machine** — used a 3.13 venv (all deps install fine) and `brew install ffmpeg`.

## Terminal 2 — ASR / guard / eval

- **Twinly G1: `voice_not_set_up`, no audio yet** — 2026-10-23. `GET /v1/me` is 200 in ~1.8 s and shows `mac.online:true` (app 4.2), but `mac.setup.voice` is a how-to string ("Record a voice: Twinly, Voice, then Build my clone") instead of `true`. The one real `POST /v1/voice/speak?wait=25` ("Hello, this is a test.") returned in 2.8 s with HTTP **200** and a job body `status:"failed"`, `error.code:"voice_not_set_up"` (not a 4xx), so errors can arrive inside a 200 job. Fix needs the Mac owner: Twinly app > Voice > Build my clone. Not retried (no credit burned on a known failure). Audio playback and real latency are still unverified until the clone exists. Shapes saved in `fixtures/real_twinly_me.json`, `fixtures/real_twinly_speak.json`; `voice.health()` reads `me.mac.setup.voice === true` as `voice_ready`.

## Terminal 3 — frontend / docs

