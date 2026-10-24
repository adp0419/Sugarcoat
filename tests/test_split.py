import pytest

from backend import split


def W(*items):
    """(word, start, end) -> word dicts."""
    return [{"w": w, "start": s, "end": e} for w, s, e in items]


def test_splits_on_terminal_punctuation():
    assert split.split_sentences("Hello there. How are you? Fine!") == ["Hello there.", "How are you?", "Fine!"]


def test_no_punctuation_single_sentence():
    assert split.split_sentences("so we meet on monday at five") == ["so we meet on monday at five"]


def test_decimal_and_time_not_split():
    assert split.split_sentences("Gate 6.45 is open. Go now.") == ["Gate 6.45 is open.", "Go now."]


def test_abbreviation_and_lowercase_continuation_not_split():
    assert split.split_sentences("Ask Dr. Patel about it. Thanks.") == ["Ask Dr. Patel about it.", "Thanks."]
    assert split.split_sentences("at 5 p.m. and then we leave.") == ["at 5 p.m. and then we leave."]


def test_empty_and_whitespace():
    assert split.split_sentences("") == []
    assert split.split_sentences("   ") == []


def test_pause_split_with_word_timings():
    words = W(("we", 0, .2), ("meet", .2, .5), ("monday", .5, 1.0), ("also", 2.0, 2.3), ("bring", 2.3, 2.6), ("snacks", 2.6, 3.0))
    text = "we meet monday also bring snacks"
    assert split.split_sentences(text, words) == ["we meet monday", "also bring snacks"]


def test_short_pause_does_not_split():
    words = W(("we", 0, .2), ("meet", .5, .8), ("monday", 1.0, 1.4))
    assert split.split_sentences("we meet monday", words) == ["we meet monday"]


def test_pause_threshold_is_configurable():
    words = W(("a", 0, .1), ("b", .5, .6))
    assert split.split_sentences("a b", words, pause=0.3) == ["a", "b"]


def test_words_not_matching_text_fall_back_to_punctuation():
    words = W(("x", 0, .1), ("y", 5, 5.1))
    assert split.split_sentences("One. Two.", words) == ["One.", "Two."]


def test_accepts_objects_with_attributes():
    class Wd:
        def __init__(self, w, s, e):
            self.w, self.start, self.end = w, s, e

    words = [Wd("hi", 0, .2), Wd("there", 2.0, 2.2)]
    assert split.split_sentences("hi there", words) == ["hi", "there"]


# ---- packer ---------------------------------------------------------------
def test_pack_short_text_one_chunk():
    assert split.pack("Hello. World.") == ["Hello. World."]


def test_pack_never_exceeds_limit_and_keeps_order():
    sents = [f"This is sentence number {i} and it has a few words in it." for i in range(40)]
    chunks = split.pack(" ".join(sents), 550)
    assert all(len(c) <= 550 for c in chunks)
    assert len(chunks) > 1
    assert " ".join(chunks) == " ".join(sents)


def test_pack_never_splits_mid_sentence_when_it_fits():
    sents = [f"Sentence {i} is here with some padding words to make it longer." for i in range(30)]
    for c in split.pack(" ".join(sents), 550):
        parts = [p for p in c.split(". ") if p]
        assert all(p.startswith("Sentence") for p in parts)
        assert c.endswith(".")


def test_pack_long_sentence_splits_at_commas():
    clause = "we will bring the red folders and the blue folders"
    sent = ", ".join([clause] * 14) + "."
    assert len(sent) > 550
    chunks = split.pack(sent, 550)
    assert len(chunks) >= 2
    assert all(len(c) <= 550 for c in chunks)
    assert all(c.rstrip(",.").endswith("folders") for c in chunks)
    assert " ".join(chunks).replace(",", "").replace(".", "") == sent.replace(",", "").replace(".", "")


def test_pack_giant_run_without_commas_falls_back_to_words():
    sent = " ".join(["word"] * 400) + "."
    chunks = split.pack(sent, 550)
    assert all(len(c) <= 550 for c in chunks)
    assert " ".join(chunks) == sent


def test_pack_single_overlong_token_hard_cut():
    chunks = split.pack("x" * 1300, 550)
    assert all(len(c) <= 550 for c in chunks)
    assert "".join(chunks) == "x" * 1300


def test_pack_accepts_sentence_list():
    assert split.pack(["One.", "Two."]) == ["One. Two."]


def test_pack_empty():
    assert split.pack("") == []
