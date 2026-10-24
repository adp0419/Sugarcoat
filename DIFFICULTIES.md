# DIFFICULTIES

Each terminal logs under its own heading.

## T1 core backend
- **Gemini key rejected (401 UNAUTHENTICATED, reason ACCESS_TOKEN_TYPE_UNSUPPORTED)** — 2026-10-23. `GEMINI_API_KEY` in `.env` starts with `AQ.` (53 chars); AI Studio API keys start with `AIza`. Looks like an OAuth/other token, not an AI Studio key. Fix: create a key at aistudio.google.com/apikey. Meanwhile real-mode rewrite fails over to the deterministic minimal rung and MOCK=1 covers UI work.
- **Python 3.13 / no ffmpeg** — machine had no python3.11 or ffmpeg; used 3.13 venv (all deps install fine) and `brew install ffmpeg`.
