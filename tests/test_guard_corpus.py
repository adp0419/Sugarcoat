"""Guard vs labelled realistic rewrites (eval/guard_cases.json). Zero false positives is a hard requirement;
known false negatives are listed explicitly so a fix (or a regression) shows up."""
import json
from pathlib import Path

import pytest

from backend import guard

ROOT = Path(__file__).resolve().parent.parent
CASES = json.loads((ROOT / "eval" / "guard_cases.json").read_text())
# Semantic changes with no number/date/name/negation/hedge/quantifier signal: left to the Decisions verifier.
# cs_swapped/cs_added/cs_dropped were fixed in round 3 by the content-word rules. ho_role_swap keeps the same words
# in the same order ("A will review B's proposal" -> "B will review A's proposal"): no deterministic signal.
KNOWN_FN = {"ho_role_swap"}


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_corpus(case):
    r = guard.check_rules(case["original"], case["rewrite"], protected=case.get("protected", ()))
    if case["expect"] == "pass":
        assert r.passed, f"false positive: {[v.message for v in r.violations]}"
    elif case["id"] in KNOWN_FN:
        if r.passed:
            pytest.xfail("known false negative (deterministic layer); Decisions verifier's job")
        pytest.fail(f"{case['id']} is now caught: remove it from KNOWN_FN")
    else:
        assert not r.passed, f"false negative: {case['why']}"


def test_corpus_size():
    assert len(CASES) >= 40 and sum(c["expect"] == "fail" for c in CASES) >= 20


# ---- the round-2 rules, one focused test each --------------------------------
def test_protected_term_accepts_asr_mishearing():
    o = "Hi, I'm, uh, Ariane Patel and I'm a computer science major."
    r = "Hi, I'm Aryan Patel, and I'm a computer science major."
    assert guard.check_rules(o, r, protected=["Aryan Patel"]).passed
    assert not guard.check_rules(o, r).passed  # unconfirmed name change is still blocked
    assert not guard.check_rules(o, "Hi, I'm Adrian Patel.", protected=["Aryan Patel"]).passed


def test_negation_repeated_in_false_start_counts_once():
    assert guard.check_rules("we can't, uh, we cannot ship this until Friday", "We cannot ship this until Friday.").passed


def test_negation_moved_to_affirmed_value_blocked():
    o = "we're not meeting on Thursday, we're meeting on Friday"
    assert {"negation"} <= {v.rule for v in guard.check_rules(o, "We're meeting on Thursday, not Friday.").violations}
    assert guard.check_rules(o, "We're meeting on Friday, not Thursday.").passed


def test_sentence_start_name_swap_blocked():
    if not guard._dictionary():
        pytest.skip("no system word list")
    assert not guard.check_rules("Sarah will present on Tuesday.", "Priya will present on Tuesday.").passed
    assert guard.check_rules("Sarah will, uh, present on Tuesday.", "Sarah will present on Tuesday.").passed
    assert guard.check_rules("um attendance is mandatory", "Attendance is mandatory.").passed


def test_content_rules_round3():
    o = "Wait, I'm actually a computer science major, but with a minor in business administration."
    assert {v.rule for v in guard.check_rules(o, "I'm a computer science major.").violations} == {"dropped_fact"}
    assert "reordered" in {v.rule for v in guard.check_rules(
        o, "I'm a business administration major with a minor in computer science.").violations}
    assert "finance" in guard.check_rules(o, "I'm a computer science major with a minor in business administration "
                                             "and finance.").violations[0].message
    # a corrected content word may go; a list may be reordered
    assert guard.check_rules("We'll meet at the city library, no wait, the school gym, at 4.",
                             "We'll meet at the school gym at 4.").passed
    assert guard.check_rules("Bring your laptop, your charger and a notebook.",
                             "Bring a notebook, your laptop and your charger.").passed
    assert not guard.check_rules("You can leave early if your lab report is finished.", "You can leave early.").passed


def test_let_me_rephrase_is_a_correction_marker():
    src = "The meeting is in room 204 on Monday. Let me rephrase. the meeting is in room 210 on Monday."
    assert guard.check_rules(src, "The meeting is in room 210 on Monday.").passed
    assert not guard.check_rules(src, "The meeting is in room 204 on Monday.").passed
