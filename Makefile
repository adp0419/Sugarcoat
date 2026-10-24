PY := .venv/bin/python
PORT ?= 8000

.PHONY: setup run mock test lint warm

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

lint:
	$(PY) -m compileall -q backend
	@$(PY) -m ruff check backend tests 2>/dev/null || echo "(ruff not installed; compile check only)"
