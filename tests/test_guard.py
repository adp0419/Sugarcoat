"""Spec for the deterministic meaning guard (docs/md/08). No network."""
import pytest

from backend import guard

CANON_IN = (
    "So, um, I just wanted to, uh, announce that we're going to have our meeting "
    "on Friday—actually, sorry, Monday, at 5 PM, and, um, everyone should be there."
)
CANON_OUT = "Our meeting will take place on Monday at 5 PM. Everyone should attend."


def rules(orig, rew, **kw):
    return {v.rule for v in guard.check_rules(orig, rew, **kw).violations}


def ok(orig, rew, **kw):
    r = guard.check_rules(orig, rew, **kw)
    assert r.passed, [v.message for v in r.violations]


def bad(orig, rew, rule=None, **kw):
    r = guard.check_rules(orig, rew, **kw)
    assert not r.passed
    if rule:
        assert rule in {v.rule for v in r.violations}, r.violations


# ---- canonical demo -------------------------------------------------------
def test_canonical_passes():
    ok(CANON_IN, CANON_OUT)


def test_friday_rewrite_blocked():
    r = guard.check_rules(CANON_IN, "Our meeting will take place on Friday at 5 PM. Everyone should attend.")
    assert not r.passed
    found = {v.rule for v in r.violations}
    assert "superseded_value" in found and "dropped_fact" in found
    assert any("friday" in v.message.lower() for v in r.violations)


def test_wrong_time_blocked():
    bad(CANON_IN, "Our meeting will take place on Monday at 6 PM. Everyone should attend.", "invented_fact")


def test_dropped_day_blocked():
    bad(CANON_IN, "Our meeting is at 5 PM. Everyone should attend.", "dropped_fact")


# ---- extraction / normalisation -----------------------------------------
def kv(text):
    return {(f.kind, f.key) for f in guard.extract(text).final}


def test_canonical_final_values_resolve_self_correction():
    ex = guard.extract(CANON_IN)
    assert ("day", "monday") in {(f.kind, f.key) for f in ex.final}
    assert ("day", "friday") not in {(f.kind, f.key) for f in ex.final}
    assert ("day", "friday") in {(f.kind, f.key) for f in ex.superseded}


def test_spoken_numbers():
    assert ("num", "22") in kv("we need twenty two chairs")
    assert ("num", "100") in kv("about a hundred people")
    assert ("num", "105") in kv("one hundred and five seats")
    assert ("num", "2005") in kv("two thousand five")


def test_spoken_time_equals_digit_time():
    assert kv("meet at five p m") == kv("meet at 5 PM") == kv("meet at 5 p.m.")
    assert ("time", "5:30") in kv("five thirty p m")
    assert ("time", "6:45") in kv("gate 17 at 6:45")


def test_one_pronoun_not_a_number():
    assert not kv("no one knows which one of us")


def test_ordinals_and_months():
    assert kv("on march fifth") == kv("on March 5th")
    assert ("month", "march") not in kv("we march forward")


# ---- numbers / times ---------------------------------------------------
def test_spoken_vs_digit_rewrite_passes():
    ok("so um let's meet at five p m", "Let's meet at 5 PM.")


def test_number_changed_blocked():
    bad("flight 482 leaves gate 17 at 6:45", "Flight 482 leaves gate 18 at 6:45.")


def test_numbers_heavy_reordered_passes():
    ok("uh flight 482 leaves gate 17 at 6:45", "Flight 482 leaves from gate 17 at 6:45.")


def test_meridian_flip_blocked():
    bad("see you at 6 pm", "See you at 6 AM.")


def test_bare_hour_matches_pm_hour():
    ok("see you at five", "See you at 5 PM.")


def test_invented_fact_blocked():
    bad("we should meet soon", "We should meet at 5 PM.", "invented_fact")


def test_self_correction_number():
    ok("we need ten, no wait, twelve chairs", "We need twelve chairs.")
    bad("we need ten, no wait, twelve chairs", "We need ten chairs.", "superseded_value")


def test_self_correction_time():
    o = "starts at 3 pm, actually, 4 pm"
    ok(o, "It starts at 4 PM.")
    bad(o, "It starts at 3 PM.")


def test_value_repeated_not_superseded():
    ok("meet Monday, actually Monday at 5", "Meet Monday at 5.")


# ---- negation ----------------------------------------------------------
def test_negation_flip_blocked():
    bad("we're not meeting Thursday", "We are meeting Thursday.", "negation")


def test_negation_added_blocked():
    bad("we are meeting Thursday", "We are not meeting Thursday.", "negation")


def test_contraction_equivalent_passes():
    ok("we won't meet Thursday", "We will not meet Thursday.")
    ok("we will not meet Thursday", "We won't meet Thursday.")


def test_no_wait_marker_is_not_negation():
    ok("meet Friday no wait Monday", "Meet Monday.")


# ---- hedges / modals / quantifiers --------------------------------------
def test_hedge_dropped_blocked():
    r = rules("I think we might meet around five", "We will meet at 5.")
    assert "hedge_dropped" in r


def test_around_before_number_kept_passes():
    ok("we'll meet around five", "We will meet around 5.")


def test_hedge_synonym_passes():
    ok("maybe we meet Monday", "Perhaps we meet Monday.")


def test_hedge_added_blocked():
    bad("we meet Monday", "We might meet Monday.", "hedge_added")


def test_about_as_preposition_is_not_hedge():
    ok("so um let's talk about the budget", "Let's talk about the budget.")


def test_quantifier_changed_blocked():
    bad("everyone should come", "Some people should come.", "quantifier")


def test_quantifier_synonym_passes():
    ok("everybody should come", "Everyone should come.")


def test_modal_strength_blocked():
    bad("you must attend", "You should attend.", "modal")
    bad("you should attend", "You must attend.", "modal")


def test_going_to_motion_is_not_modal():
    ok("I'm going to the store", "I am going to the store.")


# ---- names / protected -----------------------------------------------
def test_name_changed_blocked():
    bad("tell Sarah we meet Monday", "Tell Priya we meet Monday.", "invented_fact")


def test_name_dropped_blocked():
    bad("tell Sarah we meet Monday", "Tell them we meet Monday.", "dropped_fact")


def test_name_at_sentence_start_not_invented():
    ok("tell Sarah we meet Monday", "Sarah will hear that we meet Monday.")


def test_protected_term_kept():
    bad("we deploy on voiceflow tonight", "We deploy on the platform tonight.", "protected_term", protected=["voiceflow"])
    ok("we deploy on voiceflow tonight", "We deploy on VoiceFlow tonight.", protected=["voiceflow"])


# ---- length / empties ---------------------------------------------------
def test_empty_rewrite_ok_without_facts():
    ok("um uh so yeah", "")


def test_empty_rewrite_blocked_with_facts():
    bad("um meet Monday", "", "dropped_fact")


def test_identical_passes():
    ok("The meeting is Monday at 5 PM.", "The meeting is Monday at 5 PM.")


def test_too_long_blocked():
    orig = "we are meeting Monday at five p m in the main hall for a quick sync"
    bad(orig, orig + " " + "and we will talk at great length about many things " * 4, "length")


def test_presenter_mode_allows_more_compression():
    orig = "um uh so yeah we will meet Monday you know so"
    rew = "We meet Monday."
    bad(orig, rew, "length", mode="natural")
    ok(orig, rew, mode="presenter")


# ---- CLI ---------------------------------------------------------------
def test_cli_exit_codes(capsys):
    assert guard.main(["five p m", "5 PM"]) == 0
    assert guard.main(["meet Friday actually Monday", "Meet Friday."]) == 1
    assert "FAIL" in capsys.readouterr().out


def test_async_check_returns_contract_model():
    import asyncio

    res = asyncio.run(guard.check(CANON_IN, "Our meeting will take place on Friday at 5 PM."))
    assert res.pass_ is False and res.verifier == "offline"
    assert res.model_dump(by_alias=True)["pass"] is False
    assert asyncio.run(guard.check(CANON_IN, CANON_OUT)).pass_ is True
