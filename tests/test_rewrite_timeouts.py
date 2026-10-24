"""A hung or erroring Gemma must never hang a job (no network: Gemma and the guard are faked)."""
import asyncio
import time

import pytest

from backend import main, rewrite as rw
from backend.config import settings
from backend.models import GuardResult, Job

VERBATIM = "So, um, the meeting is on Monday at 5 PM."


@pytest.fixture
def real_mode(monkeypatch):
    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test")
    monkeypatch.setattr(settings, "GEMMA_TIMEOUT_S", 0.2)
    monkeypatch.setattr(settings, "GEMMA_BUDGET_S", 1.5)

    async def fake_guard(verbatim, rewrite_text, mode="natural", protected=None):
        return GuardResult(**{"pass": True, "verifier": "offline"})
    monkeypatch.setattr(main, "_guard", fake_guard)


def _run(mode="natural"):
    st = main.JobState(Job(id="t", verbatim=VERBATIM))
    t = time.perf_counter()
    asyncio.run(main.run_ladder_watched(st, mode, time.perf_counter()))
    return st.job, time.perf_counter() - t


def test_hung_gemma_falls_back_within_budget(real_mode, monkeypatch):
    async def hang(prompt, model):
        await asyncio.sleep(60)
    monkeypatch.setattr(rw, "_generate", hang)
    job, secs = _run()
    assert job.rung in ("minimal", "original") and job.rewrite
    assert "um" not in job.rewrite.lower().split()
    assert secs < 3


def test_gemma_500_falls_back_fast(real_mode, monkeypatch):
    calls = []

    async def boom(prompt, model):
        calls.append(model)
        raise RuntimeError("500 INTERNAL. Internal error encountered.")
    monkeypatch.setattr(rw, "_generate", boom)
    job, secs = _run()
    assert job.rung in ("minimal", "original")
    assert len(calls) == 2  # one retry, then the ladder moves on
    assert secs < 2


def test_watchdog_ends_a_stuck_ladder(real_mode, monkeypatch):
    monkeypatch.setattr(settings, "JOB_DEADLINE_S", 0.5)

    async def stuck(st, mode):
        await asyncio.sleep(60)
    monkeypatch.setattr(main, "run_ladder", stuck)
    job, secs = _run()
    assert job.rung == "original" and job.rewrite == VERBATIM
    assert any("watchdog" in n for n in job.notes)
    assert secs < 3


def test_protected_terms_reach_the_prompt():
    p = rw.build_prompt("my name is Ariane Patel", "natural", protected=["Aryan Patel"])
    assert "Aryan Patel" in p and "PROTECTED" in p
