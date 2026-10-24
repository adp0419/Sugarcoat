"""rewrite.minimal: phrase repeats (2-4 words) collapse; legitimate repeats survive. No network."""
import pytest

from backend import guard, rewrite as rw


@pytest.mark.parametrize("src,want", [
    ("I want to I want to go home.", "I want to go home."),
    ("I want to, I want to go home.", "I want to go home."),
    ("We need, we need more chairs.", "We need more chairs."),
    ("We can we can we can do it.", "We can do it."),
    ("The meeting is, the meeting is on Monday.", "The meeting is on Monday."),
    ("Monday at 5, Monday at 5 works.", "Monday at 5 works."),
    ("So um I think I think we should go.", "So I think we should go."),
])
def test_phrase_repeats_collapse(src, want):
    r = rw.minimal(src)
    assert r.rewrite == want
    assert any(e.reason == "repetition" for e in r.edits)
    assert guard.check_rules(src, r.rewrite, "minimal").passed


@pytest.mark.parametrize("src", [
    "It is what it is.",
    "Step by step we go.",
    "We met again and again.",
    "Little by little, it got better.",
    "One by one, they left.",
])
def test_non_adjacent_repeats_survive(src):
    assert rw.minimal(src).rewrite == src


def test_word_repeat_still_works():
    assert rw.minimal("So the the plan is is fine.").rewrite == "So the plan is fine."
