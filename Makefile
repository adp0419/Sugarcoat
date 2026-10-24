PY := .venv/bin/python
PORT ?= 8000

.PHONY: setup run mock test eval lint warm smoke

setup:  ## venv + deps (needs ffmpeg: brew install ffmpeg)
	python3 -m venv .venv
	$(PY) -m pip install -r requirements.txt
	@test -f .env || cp .env.example .env

warm:  ## download ASR weights once (then set HF_HUB_OFFLINE=1 on demo day)
	$(PY) -c "from crisperwhisper import CrisperWhisperModel as M; import os; M(os.environ.get('ASR_SIZE','turbo'))"

run:  ## real mode, no --reload (reload kills the model load)
	$(PY) -m uvicorn backend.main:app --host $${HOST:-127.0.0.1} --port $(PORT)

mock:  ## everything stubbed from fixtures/
	MOCK=1 $(PY) -m uvicorn backend.main:app --host $${HOST:-127.0.0.1} --port $(PORT)

test:  ## no network
	MOCK=1 $(PY) -m pytest -q

smoke:  ## against a running server: N=5 runs of frontend/demo-clip.m4a (BASE=..., SPEAK=1 adds one real speak ~$$0.10)
	$(PY) scripts/smoke.py

eval:  ## text-only eval table; real APIs where keys allow (add ARGS=--offline for no network)
	$(PY) eval/run_eval.py $(ARGS)

lint:
	$(PY) -m compileall -q backend
	@$(PY) -m ruff check backend tests 2>/dev/null || echo "(ruff not installed; compile check only)"
