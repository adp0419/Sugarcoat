# 16 Environment setup (do first, 30 min)

## System (macOS, M-series)
```
brew install ffmpeg python@3.11 node git
python3.11 -m venv .venv && source .venv/bin/activate
```
## requirements.txt (pin after first successful install: `pip freeze`)
```
fastapi uvicorn[standard] python-multipart httpx pydantic pydantic-settings python-dotenv
openai google-genai pytest pytest-asyncio
crisperwhisper[transformers]     # large download (torch); start FIRST
```
Install CrisperWhisper in a separate terminal now; it's the slowest step. Then trigger weight download: run `python -c "from crisperwhisper import CrisperWhisperModel as M; M('turbo')"`.

## .env.example
```
TWINLY_API_KEY=twk_live_xxx
TWINLY_BASE=https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1
OPENAI_API_KEY=sk-xxx
DECISIONS_MODEL=gpt-6-luna
GEMINI_API_KEY=xxx
GEMMA_MODEL=gemma-4-26b-a4b-it
ASR_SIZE=turbo
MOCK=0
DECISIONS_ENABLED=1
KEEP_AUDIO=0
HOST=127.0.0.1
PORT=8000
```
Each teammate has their own keys in their own `.env`; share the Twinly key only with whoever runs the demo, via DM (not Discord channel/GitHub). Rotate if exposed.

## Makefile
`make setup` (venv + pip + npm if used) · `make run` (`uvicorn backend.main:app --reload --port 8000`) · `make test` · `make eval` · `make mock` (MOCK=1) · `make lint`.

## .gitignore
`.env  .venv  __pycache__  cache/  logs/  *.wav  *.webm  node_modules  .DS_Store  models/  .cache/` (keep `fixtures/` and small `eval/audio/`).

## Twinly Mac checklist
Twinly app ≥4.1.2 · signed in · Terms accepted · Settings ▸ Developer API: create key, enable "Let keys text, call and run tasks as you" · Voice screen: Build my clone · redeem credits code · Energy settings: prevent sleep, `caffeinate -d` in a terminal · Messages signed in (stretch) · test `curl -H "Authorization: Bearer $TWINLY_API_KEY" $TWINLY_BASE/me`.

## Verify commands
```
curl -s localhost:8000/api/health | jq
python -m backend.guard "five p m" "5 PM"
python -m backend.rewrite --mode natural "um so Friday actually Monday at five"
python -m backend.voice "Hello, this is a test."   # costs $0.10
```

## Claude Code tips for this repo
Start each session: "Read CLAUDE.md and the docs relevant to <module>." Give one module + its doc per session. Ask for tests first on guard. Tell it VERIFY items must be tested with a real call before depending on them. Keep fixtures from real responses (they become MOCK data and docs ground truth).

## Troubleshooting
- `ModuleNotFoundError crisperwhisper` → wrong venv. · mic denied → use `http://localhost`, not IP. · 403 origin_not_allowed → you called Twinly from browser. · 409 twinly_offline → wake Mac. · Gemma 429 → wait/lower parallelism. · torch MPS op errors → `PYTORCH_ENABLE_MPS_FALLBACK=1`. · uvicorn reload kills model load → run without `--reload` for demos.
