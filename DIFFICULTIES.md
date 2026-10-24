# Difficulties

Problems we hit, what we tried, and what we did. Each terminal appends only under its own heading.

## Terminal 1 — backend / pipeline

- **Gemini key rejected (401 UNAUTHENTICATED, ACCESS_TOKEN_TYPE_UNSUPPORTED)** — 2026-10-23. `GEMINI_API_KEY` in `.env` starts with `AQ.` (53 chars); AI Studio API keys start with `AIza`, so this looks like an OAuth-style token. Fix: create a key at aistudio.google.com/apikey. Until then real-mode rewrite falls to the deterministic minimal rung; MOCK=1 covers UI work.
- **No python3.11 / ffmpeg on the machine** — used a 3.13 venv (all deps install fine) and `brew install ffmpeg`.

## Terminal 2 — ASR / guard / eval

## Terminal 3 — frontend / docs

