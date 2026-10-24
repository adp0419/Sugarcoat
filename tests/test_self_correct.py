"""Deterministic self-correction in the fallback rung (rewrite.minimal, natural/presenter). No network."""
import pytest

from backend import guard, rewrite as rw

CANON = ("So, um, I just wanted to, uh, announce that we're going to have our meeting on Friday—actually, sorry, "
         "Monday, at 5 PM, and, um, everyone should be there.")
BACKTRACK = ("I'm a computer science major here at the University of Florida. Wait, I'm actually a computer science "
             "major, but with a minor business administration here at the University of Florida.")


def _fix(text, mode="natural"):
    return rw.minimal(text, mode)


def _passes(original, rewrite, mode="natural"):
    g = guard.check_rules(original, rewrite, mode)
    assert g.passed, [v.message for v in g.violations]


# ---- corrections that must fire (and pass the guard) ----
@pytest.mark.parametrize("src,want", [
    ("on Friday—actually, sorry, Monday, at 5 PM", "On Monday, at 5 PM"),
    ("We meet Tuesday, no wait, Wednesday at 3.", "We meet Wednesday at 3."),
    ("The deadline is tomorrow, no wait, today at noon.", "The deadline is today at noon."),
    ("It costs $20, actually $25.", "It costs $25."),
    ("Doors open at 5 PM, sorry, 6 PM.", "Doors open at 6 PM."),
    ("Doors open at 5 o'clock, I mean 6 o'clock.", "Doors open at 6 o'clock."),
    ("The launch is March 3rd, I mean March 4th.", "The launch is March 4th."),
    ("Let's meet on Friday, sorry, on Monday.", "Let's meet on Monday."),
    ("Bring 10, make that 12 chairs.", "Bring 12 chairs."),
    ("It's in June, or rather July.", "It's in July."),
    ("um so Friday actually Monday at five", "So Monday at five"),
    ("We need twenty, sorry, thirty volunteers.", "We need thirty volunteers."),
    ("Call me at 5:30, scratch that, 6:15.", "Call me at 6:15."),
])
def test_inline_corrections(src, want):
    r = _fix(src)
    assert r.rewrite == want
    assert any(e.reason == "self_correction" for e in r.edits)
    _passes(src, r.rewrite)


def test_canonical_utterance():
    r = _fix(CANON)
    assert r.rewrite == ("So I just wanted to announce that we're going to have our meeting on Monday, at 5 PM, "
                         "and everyone should be there.")
    assert "Friday" not in r.rewrite
    _passes(CANON, r.rewrite)
    _passes(CANON, _fix(CANON, "presenter").rewrite, "presenter")


def test_users_backtrack_sentence():
    r = _fix(BACKTRACK)
    assert r.rewrite == ("I'm actually a computer science major, but with a minor business administration here at the "
                         "University of Florida.")
    sc = [e for e in r.edits if e.reason == "self_correction"]
    assert len(sc) == 1 and sc[0].from_.endswith("Wait,")
    _passes(BACKTRACK, r.rewrite)


@pytest.mark.parametrize("marker", ["Actually,", "Sorry,", "No wait,", "I mean,", "Let me rephrase.", "Correction:"])
def test_restart_markers(marker):
    src = f"The meeting is in room 204 on Monday. {marker} the meeting is in room 210 on Monday."
    r = _fix(src)
    assert r.rewrite == "The meeting is in room 210 on Monday."
    if marker != "Let me rephrase.":  # guard.MARKER_* lacks "let me rephrase" (reported to T2): it keeps 204 final
        _passes(src, r.rewrite)


def test_chained_inline_corrections():
    assert _fix("We need 5, no, 6, sorry, 7 chairs.").rewrite == "We need 7 chairs."


# ---- must NOT fire ----
@pytest.mark.parametrize("src", [
    "I actually like Fridays.",
    "Wait for me at 5.",
    "At 5 no one came.",
    "Sorry, I can't make it on Monday.",
    "I'd rather meet at 5 than 6.",
    "We have 3 rooms, actually quite big ones.",
    "Let's do Friday actually, Monday is booked.",
    "I mean it, the deadline is Friday.",
    "Monday, sorry, 5 PM works.",  # different kinds: day vs time
    "Doors open at 5, I mean 6 PM.",  # number vs time: left for Gemma (the guard cannot pair them)
    "In 2020, I mean, things were hard.",
])
def test_no_false_positives(src):
    r = _fix(src)
    assert not [e for e in r.edits if e.reason == "self_correction"], r.rewrite
    if "I mean" not in src:  # the filler rung strips "I mean" on its own (pre-existing behaviour)
        assert r.rewrite == src


def test_low_overlap_restart_keeps_both():
    src = "We meet Monday. Actually, Tuesday works too."
    r = _fix(src)
    assert r.rewrite == src and not r.edits


def test_restart_needs_previous_sentence():
    src = "Wait, the room is 204."
    assert _fix(src).rewrite == src


def test_marker_only_sentence_without_restart_is_kept():
    src = "We meet Monday. Let me rephrase. Bring snacks."
    assert _fix(src).rewrite == src


def test_minimal_mode_is_filler_only():
    r = _fix(CANON, "minimal")
    assert "Friday" in r.rewrite and "Monday" in r.rewrite
    assert all(e.reason != "self_correction" for e in r.edits)
    b = _fix(BACKTRACK, "minimal")
    assert b.rewrite.count("University of Florida") == 2


def test_ladder_uses_self_correction_and_notes_it(monkeypatch):
    """Gemma down -> deterministic rung fixes the self-correction and the job says so."""
    import asyncio
    import time

    from backend import main
    from backend.config import settings
    from backend.models import Job

    monkeypatch.setattr(settings, "MOCK", False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test")

    async def no_credits(prompt, model):
        raise RuntimeError("402 RESOURCE_EXHAUSTED. Your prepayment credits are depleted.")
    monkeypatch.setattr(rw, "_generate", no_credits)

    async def det_guard(verbatim, rewrite_text, mode="natural", protected=None):
        from backend.models import GuardResult, Violation
        g = guard.check_rules(verbatim, rewrite_text, mode, protected or ())
        return GuardResult(**{"pass": g.passed, "verifier": "offline",
                              "violations": [Violation(**v.to_dict()) for v in g.violations]})
    monkeypatch.setattr(main, "_guard", det_guard)

    st = main.JobState(Job(id="sc", verbatim=CANON))
    t = time.perf_counter()
    asyncio.run(main.run_ladder_watched(st, "natural", time.perf_counter()))
    job = st.job
    assert time.perf_counter() - t < 2  # 402 is not retried
    assert job.rung == "minimal" and "Friday" not in job.rewrite and job.guard.pass_
    assert main.NOTE_SELF_CORRECTED in job.notes
