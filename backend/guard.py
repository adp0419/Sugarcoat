"""Deterministic meaning guard (docs/md/08).

Pure functions on plain strings: ``check(original, rewrite)`` returns a
``GuardResult``. Any violation here is a hard FAIL, whatever the Decisions
verifier says. Run: ``python -m backend.guard "verbatim" "rewrite"``.
"""
from __future__ import annotations

import asyncio
import bisect
import difflib
import re
import sys
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Iterable, Sequence

from . import models

# --------------------------------------------------------------------------
# vocab
# --------------------------------------------------------------------------
UNITS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
         "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
NUM_WORDS = set(UNITS) | set(TEENS) | set(TENS) | {"hundred", "thousand"}
ORDINALS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
            "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14,
            "fifteenth": 15, "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19,
            "twentieth": 20, "thirtieth": 30}
ONE_FOLLOW = {"pm", "am", "p", "o'clock", "percent", "dollars", "minutes", "hours", "people"}
ONE_PREV = {"at", "until", "by", "before", "after", "around", "about"}

DAYS = {"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
        "tomorrow", "today", "yesterday", "tonight"}
DAY_ALIASES = {"tues": "tuesday", "thurs": "thursday", "weds": "wednesday"}
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
          "october", "november", "december"]
MONTH_ABBR = {m[:3]: m for m in MONTHS} | {"sept": "september"}
MONTH_NEEDS_NUM = {"may", "march"} | set(MONTH_ABBR)

MARKER_1 = {"actually", "sorry", "rather", "correction", "oops", "whoops", "rephrase"}  # "let me rephrase"
MARKER_2 = {("i", "mean"), ("no", "wait"), ("wait", "no"), ("scratch", "that"), ("make", "that"), ("or", "rather")}

HEDGE_WORD = {"maybe": "possible", "perhaps": "possible", "possibly": "possible", "might": "possible",
              "could": "possible", "may": "possible", "probably": "likely", "likely": "likely",
              "roughly": "approx", "approximately": "approx", "nearly": "approx", "almost": "approx"}
HEDGE_NEEDS_NUM = {"around": "approx", "about": "approx"}
HEDGE_BIGRAM = {("i", "think"): "think", ("i", "guess"): "think", ("i", "suppose"): "think",
                ("i", "believe"): "think", ("sort", "of"): "sortof", ("kind", "of"): "sortof"}

NEGATIONS = {"not", "never", "no", "none", "nobody", "nothing", "nowhere", "cannot", "without", "nor", "neither"}
QUANT = {"all": "all", "every": "all", "everyone": "all", "everybody": "all", "everything": "all", "each": "all",
         "some": "some", "someone": "some", "somebody": "some", "most": "most", "few": "few", "several": "few",
         "none": "none", "nobody": "none"}
NOT_MODAL_AFTER = {"the", "a", "an", "my", "our", "his", "her", "their", "your", "this", "that", "these", "those",
                   "school", "work", "class", "bed", "church", "town", "home"}
NOT_NAMES = {"i", "am", "pm", "ok", "okay", "may", "march", "august"}
# words that may separate a negation from its own repeat in a false start: "can't, uh, we cannot"
REPEAT_GAP = {"um", "uh", "er", "erm", "ah", "hmm", "like", "so", "well", "i", "we", "you", "he", "she", "they", "it"}
# sentence-start words that are never names (fillers, greetings, modern words missing from the 1934 dictionary)
COMMON_EXTRA = {"um", "uh", "er", "erm", "ah", "hmm", "mm", "okay", "ok", "hey", "hi", "hello", "yeah", "yep", "nope",
                "gonna", "wanna", "gotta", "email", "emails", "online", "laptop", "laptops", "website", "wifi", "app",
                "apps", "everyone", "everybody", "anyone", "anybody", "someone", "somebody", "anyway", "basically",
                "actually", "also", "let", "us", "attendee", "attendees", "rsvp", "teammate", "teammates", "signup",
                "login", "webinar", "internet", "homepage", "smartphone"}
# content-word rules (dropped phrase, added list item, reordered roles) ignore these: function words and
# talk that a good edit removes ("I just wanted to quickly announce that...")
STOPWORDS = {"a", "an", "the", "and", "or", "but", "so", "of", "in", "on", "at", "to", "for", "with", "from", "by",
             "is", "are", "was", "were", "be", "been", "being", "am", "i", "we", "you", "he", "she", "they", "it",
             "this", "that", "these", "those", "my", "our", "your", "his", "her", "their", "its", "me", "us", "them",
             "as", "if", "then", "than", "there", "here", "what", "which", "who", "whom", "when", "where", "why",
             "how", "do", "does", "did", "done", "have", "has", "had", "will", "would", "can", "could", "should",
             "shall", "must", "may", "might", "just", "really", "very", "also", "too", "like", "yeah", "okay", "well",
             "wait", "mean", "going", "want", "wanted", "get", "got", "about", "into", "over", "out", "up", "down",
             "any", "some", "one", "not", "no", "let", "make", "made", "take", "place", "need", "needs", "know",
             "announce", "basically", "literally", "honestly", "totally", "thing", "things", "stuff", "kind", "sort",
             "right", "even", "still", "again", "only", "said", "say", "says", "tell", "told", "please"}
_DICT_PATHS = ("/usr/share/dict/words", "/usr/share/dict/web2")
_lower_words: set[str] | None = None


def _dictionary() -> set[str]:
    """Lower-case entries of the system word list. Capitalised-only entries (Sarah, Monday) are proper nouns."""
    global _lower_words
    if _lower_words is None:
        _lower_words = set()
        for path in _DICT_PATHS:
            try:
                with open(path, encoding="utf-8", errors="ignore") as fh:
                    _lower_words = {w.strip() for w in fh if w[:1].islower()}
                break
            except OSError:
                continue
    return _lower_words


def _looks_proper(word: str) -> bool:
    """Sentence-start capitalised word -> probably a name? False when no dictionary is available."""
    words = _dictionary()
    if not words or word in COMMON_EXTRA or word in NOT_NAMES:
        return False
    w = re.sub(r"'s$", "", word)
    stems = {w}
    for suf, adds in (("ies", ("y",)), ("es", ("",)), ("s", ("",)), ("ed", ("", "e")), ("ing", ("", "e")),
                      ("ly", ("",)), ("er", ("", "e")), ("est", ("", "e"))):
        if w.endswith(suf) and len(w) > len(suf) + 2:
            stems |= {w[: -len(suf)] + a for a in adds}
    return not any(x in words for x in stems)

_CONTRACTIONS = [
    (r"\bwon't\b", "will not"), (r"\bcan't\b", "cannot"), (r"\bshan't\b", "shall not"), (r"\bain't\b", "is not"),
    (r"\blet's\b", "let us"), (r"\bgonna\b", "going to"), (r"\bwanna\b", "want to"), (r"\bgotta\b", "have to"),
    (r"(\w)n't\b", r"\1 not"), (r"'m\b", " am"), (r"'re\b", " are"), (r"'ve\b", " have"), (r"'ll\b", " will"),
    (r"'d\b", " would"),
    (r"\b(it|that|there|here|what|who|where|how|he|she)'s\b", r"\1 is"),
]

_TOK = re.compile(
    r"\d+(?::\d{2})?(?:\.\d+)?(?:(?:st|nd|rd|th)(?![a-z]))?|[A-Za-z]+(?:'[A-Za-z]+)*|[.,;:?!—]", re.I)


# --------------------------------------------------------------------------
# tokens
# --------------------------------------------------------------------------
@dataclass
class Tok:
    kind: str          # w p num time day month
    val: str
    raw: str
    cap: bool = False  # capitalised mid-sentence word (name candidate)
    start_cap: bool = False  # capitalised first word of a sentence (name only if not a dictionary word)
    mer: str = ""      # am/pm for time tokens
    ordinal: bool = False
    pos: int = -1      # index among non-punctuation tokens


@dataclass
class Fact:
    kind: str          # num time day month name
    key: str
    pos: int
    surface: str
    mer: str = ""
    superseded: bool = False


@dataclass
class Extraction:
    facts: list[Fact]
    final: list[Fact]
    superseded: list[Fact]
    words: set[str]
    toks: list[Tok]
    hedges: dict[str, str] = field(default_factory=dict)
    negations: list[str] = field(default_factory=list)
    quantifiers: dict[str, str] = field(default_factory=dict)
    modals: dict[str, str] = field(default_factory=dict)
    negated: dict[tuple[str, str], str] = field(default_factory=dict)  # facts within 4 words after a negation


def _clean(text: str) -> str:
    s = text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    s = s.replace("–", "—").replace("...", ",").replace("…", ",")
    s = re.sub(r"\s-+\s", " — ", s)
    s = s.replace("%", " percent ")
    s = re.sub(r"\$(?=\d)", "", s)
    s = re.sub(r"(?<=\d),(?=\d{3}\b)", "", s)
    s = re.sub(r"\b([ap])\.\s?m\.(?=\s+[a-z])", r"\1m", s, flags=re.I)
    s = re.sub(r"\b([ap])\.\s?m\b", r"\1m", s, flags=re.I)
    for pat, rep in _CONTRACTIONS:
        s = re.sub(pat, rep, s, flags=re.I)
    return s


def _decimal_key(s: str) -> str:
    if "." in s:
        return format(Decimal(s).normalize(), "f")
    return s.lstrip("0") or "0"


def _tokenize(text: str) -> list[Tok]:
    toks: list[Tok] = []
    sentence_start = True
    for m in _TOK.finditer(_clean(text)):
        raw = m.group(0)
        if raw[0].isdigit():
            body = re.sub(r"(st|nd|rd|th)$", "", raw, flags=re.I)
            ordinal = body != raw
            if ":" in body:
                h, mm = body.split(":")
                hh, mer = int(h), ""
                if 12 < hh < 24:
                    hh, mer = hh - 12, "pm"
                elif hh == 0 and len(h) == 2:
                    hh, mer = 12, "am"
                toks.append(Tok("time", f"{hh}:{mm}", raw, mer=mer))
            else:
                toks.append(Tok("num", _decimal_key(body), raw, ordinal=ordinal))
            sentence_start = False
        elif raw[0].isalpha():
            val = raw.lower()
            toks.append(Tok("w", val, raw, cap=raw[0].isupper() and not sentence_start,
                            start_cap=raw[0].isupper() and sentence_start))
            sentence_start = False
        else:
            toks.append(Tok("p", raw, raw))
            sentence_start = raw in ".?!"
    return toks


def _parse_num(ws: Sequence[str], i: int):
    """Parse a spoken-number run starting at ws[i]; return (value, next_i) or None."""
    total = cur = 0
    last = None
    j = i
    if ws[j] == "a" and j + 1 < len(ws) and ws[j + 1] in ("hundred", "thousand"):
        cur, last, j = 1, "unit", j + 1
    start = j
    while j < len(ws):
        w = ws[j]
        if w in UNITS and last in (None, "tens", "hundred", "scale", "and"):
            cur, last = cur + UNITS[w], "unit"
        elif w in TEENS and last in (None, "hundred", "scale", "and"):
            cur, last = cur + TEENS[w], "teen"
        elif w in TENS and last in (None, "hundred", "scale", "and"):
            cur, last = cur + TENS[w], "tens"
        elif w == "hundred" and last in ("unit", "teen") and 0 < cur < 20:
            cur, last = cur * 100, "hundred"
        elif w == "thousand" and (cur > 0 or last == "unit") and last in ("unit", "teen", "tens", "hundred"):
            total, cur, last = total + cur * 1000, 0, "scale"
        elif w == "and" and last in ("hundred", "scale") and j + 1 < len(ws) and ws[j + 1] in NUM_WORDS:
            last = "and"
        else:
            break
        j += 1
    if j == start:
        return None
    return total + cur, j


def _merge_numbers(toks: list[Tok]) -> list[Tok]:
    out: list[Tok] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        starts = t.kind == "w" and (t.val in NUM_WORDS or (t.val == "a" and i + 1 < len(toks)
                                    and toks[i + 1].val in ("hundred", "thousand")))
        if starts:
            run = []
            k = i
            while k < len(toks) and toks[k].kind == "w":
                run.append(toks[k].val)
                k += 1
            res = _parse_num(run, 0)
            if res:
                value, n = res
                nxt = toks[i + n].val if i + n < len(toks) else ""
                prev = out[-1].val if out else ""
                if n == 1 and run[0] == "one":
                    if not (nxt in ONE_FOLLOW or nxt in NUM_WORDS or (prev in ONE_PREV and nxt != "of")):
                        out.append(t)
                        i += 1
                        continue
                out.append(Tok("num", str(value), " ".join(x.raw for x in toks[i:i + n])))
                i += n
                continue
        out.append(t)
        i += 1
    return out


def _meridian_at(toks: list[Tok], i: int):
    """Return (mer, tokens_consumed) if toks[i:] spells am/pm."""
    if i >= len(toks) or toks[i].kind != "w":
        return "", 0
    v = toks[i].val
    if v in ("am", "pm"):
        return v, 1
    if v in ("a", "p") and i + 1 < len(toks) and toks[i + 1].kind == "w" and toks[i + 1].val == "m":
        return v + "m", 2
    return "", 0


def _merge_times(toks: list[Tok]) -> list[Tok]:
    out: list[Tok] = []
    i = 0
    while i < len(toks):
        t = toks[i]
        if t.kind == "w" and t.val in ("noon", "midnight"):
            out.append(Tok("time", "12:00", t.raw, mer="pm" if t.val == "noon" else "am"))
            i += 1
        elif t.kind == "time":
            mer, n = _meridian_at(toks, i + 1)
            if mer:
                t = Tok("time", t.val, t.raw + " " + mer, mer=mer)
            out.append(t)
            i += 1 + n
        elif t.kind == "num" and not t.ordinal and "." not in t.val and 1 <= int(t.val) <= 12:
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            # "six forty five p m"
            if nxt is not None and nxt.kind == "num" and len(nxt.val) == 2 and int(nxt.val) < 60 and not nxt.ordinal:
                mer, n = _meridian_at(toks, i + 2)
                if mer:
                    out.append(Tok("time", f"{int(t.val)}:{nxt.val}", f"{t.raw} {nxt.raw} {mer}", mer=mer))
                    i += 2 + n
                    continue
            mer, n = _meridian_at(toks, i + 1)
            if mer:
                out.append(Tok("time", f"{int(t.val)}:00", f"{t.raw} {mer}", mer=mer))
                i += 1 + n
            elif nxt is not None and nxt.kind == "w" and nxt.val == "o'clock":
                out.append(Tok("time", f"{int(t.val)}:00", f"{t.raw} o'clock"))
                i += 2
            else:
                out.append(t)
                i += 1
        else:
            out.append(t)
            i += 1
    return out


def _merge_dates(toks: list[Tok]) -> list[Tok]:
    n = len(toks)

    def near_num(i: int) -> bool:
        for j in (i - 1, i + 1):
            if 0 <= j < n and (toks[j].kind == "num" or (toks[j].kind == "w" and toks[j].val in ORDINALS)):
                return True
        return False

    for i, t in enumerate(toks):
        if t.kind != "w":
            continue
        v = DAY_ALIASES.get(t.val, t.val)
        if v in DAYS:
            toks[i] = Tok("day", v, t.raw)
        elif t.val in MONTHS and t.val not in MONTH_NEEDS_NUM:
            toks[i] = Tok("month", t.val, t.raw)
        elif t.val in MONTH_NEEDS_NUM and near_num(i):
            full = t.val if t.val in MONTHS else MONTH_ABBR[t.val]
            toks[i] = Tok("month", full, t.raw)
    out: list[Tok] = []
    for i, t in enumerate(toks):
        if t.kind == "w" and t.val in ORDINALS:
            prev = toks[i - 1] if i else None
            nxt = toks[i + 1] if i + 1 < n else None
            nxt2 = toks[i + 2] if i + 2 < n else None
            ok = ((prev and prev.kind == "month") or (nxt and nxt.kind == "month")
                  or (nxt and nxt.val == "of" and nxt2 and nxt2.kind == "month")
                  or (prev and prev.val == "the" and nxt and nxt.val == "of"))
            if ok:
                val = ORDINALS[t.val]
                if out and out[-1].kind == "num" and out[-1].val in ("20", "30") and val < 10:
                    base = out.pop()
                    out.append(Tok("num", str(int(base.val) + val), base.raw + " " + t.raw, ordinal=True))
                else:
                    out.append(Tok("num", str(val), t.raw, ordinal=True))
                continue
        out.append(t)
    return out


def _tokens(text: str) -> list[Tok]:
    toks = _merge_dates(_merge_times(_merge_numbers(_tokenize(text))))
    p = 0
    for t in toks:
        if t.kind != "p":
            t.pos = p
            p += 1
    return toks


def normalize(text: str) -> str:
    """Canonical token string: ``'meet at five p m'`` -> ``'meet at 5:00pm'``."""
    parts = []
    for t in _tokens(text):
        if t.kind == "time":
            parts.append(t.val + t.mer)
        elif t.kind != "p":
            parts.append(t.val)
    return " ".join(parts)


# --------------------------------------------------------------------------
# extraction
# --------------------------------------------------------------------------
def _match(a: Fact, b: Fact) -> bool:
    if a.kind == b.kind:
        if a.kind == "time":
            return a.key == b.key and (not a.mer or not b.mer or a.mer == b.mer)
        return a.key == b.key
    if {a.kind, b.kind} == {"num", "time"}:
        n, t = (a, b) if a.kind == "num" else (b, a)
        h, m = t.key.split(":")
        return m == "00" and h == n.key
    return False


def _markers(ws: list[Tok]) -> list[tuple[int, int]]:
    out = []
    i = 0
    while i < len(ws):
        v = ws[i].val if ws[i].kind == "w" else ""
        if i + 1 < len(ws) and ws[i + 1].kind == "w" and (v, ws[i + 1].val) in MARKER_2:
            out.append((i, i + 1))
            i += 2
            continue
        if v in MARKER_1:
            out.append((i, i))
        i += 1
    return out


def extract(text: str, resolve: bool = True) -> Extraction:
    toks = _tokens(text)
    ws = [t for t in toks if t.kind != "p"]
    facts: list[Fact] = []
    for t in ws:
        if t.kind in ("num", "time", "day", "month"):
            facts.append(Fact(t.kind, t.val, t.pos, t.raw, t.mer))
        elif t.kind == "w" and t.val not in NOT_NAMES and (t.cap or (t.start_cap and _looks_proper(t.val))):
            facts.append(Fact("name", re.sub(r"'s$", "", t.val), t.pos, t.raw))

    if resolve:
        for ms, me in _markers(ws):
            for kind in ("num", "time", "day", "month", "name"):
                prev = [f for f in facts if f.kind == kind and ms - 14 <= f.pos < ms]
                nxt = [f for f in facts if f.kind == kind and me < f.pos <= me + 6]
                if prev and nxt and not _match(prev[-1], nxt[0]):
                    prev[-1].superseded = True
    final = [f for f in facts if not f.superseded]
    superseded = [f for f in facts if f.superseded and not any(_match(f, g) for g in final)]

    words = set()
    for t in ws:
        words.add(t.val)
        if t.kind == "w":
            words.add(re.sub(r"'s$", "", t.val))

    ex = Extraction(facts, final, superseded, words, toks)
    _style_features(ex, ws)
    by_pos = {f.pos: f for f in facts if f.kind != "name" and not f.superseded}
    for i in ex._neg_all:  # type: ignore[attr-defined]
        for j in range(i + 1, min(i + 5, len(ws))):
            f = by_pos.get(ws[j].pos)
            if f is not None:
                ex.negated[(f.kind, f.key)] = f"{ws[i].raw} ... {f.surface}"
                break
    return ex


def _style_features(ex: Extraction, ws: list[Tok]) -> None:
    skip_no: set[int] = set()
    neg_pos: list[int] = []  # counted negations
    ex._neg_all = []  # type: ignore[attr-defined]  # every negation, repeats included (for scope)
    for i, t in enumerate(ws):
        if t.kind == "w" and t.val == "no":
            nxt = ws[i + 1].val if i + 1 < len(ws) else ""
            prv = ws[i - 1].val if i else ""
            if nxt in ("wait", "sorry", "actually", "scratch") or prv == "wait":
                skip_no.add(i)
    for i, t in enumerate(ws):
        if t.kind != "w":
            continue
        v = t.val
        nxt = ws[i + 1] if i + 1 < len(ws) else None
        nxt2 = ws[i + 2] if i + 2 < len(ws) else None
        # negations (a negation repeated in a false start counts once)
        if v in NEGATIONS and i not in skip_no:
            ex._neg_all.append(i)  # type: ignore[attr-defined]
            prev = neg_pos[-1] if neg_pos else None
            repeat = prev is not None and ws[prev].val == v or (prev is not None and {ws[prev].val, v} <= {"not", "cannot"})
            if not (repeat and all(x.val in REPEAT_GAP for x in ws[prev + 1:i])):
                ex.negations.append(t.raw)
                neg_pos.append(i)
        if v == "no" and nxt is not None and nxt.val == "one":
            ex.quantifiers["none"] = "no one"
        # quantifiers
        if v in QUANT:
            ex.quantifiers[QUANT[v]] = t.raw
        # hedges
        if v in HEDGE_WORD:
            ex.hedges[HEDGE_WORD[v]] = t.raw
        if v in HEDGE_NEEDS_NUM and any(n is not None and n.kind in ("num", "time") for n in (nxt, nxt2)):
            ex.hedges[HEDGE_NEEDS_NUM[v]] = t.raw
        if nxt is not None and (v, nxt.val) in HEDGE_BIGRAM:
            ex.hedges[HEDGE_BIGRAM[(v, nxt.val)]] = f"{t.raw} {nxt.raw}"
        # modal strength
        if v == "must":
            ex.modals["must"] = t.raw
        elif v == "should":
            ex.modals["should"] = t.raw
        elif v == "cannot" or v == "can":
            ex.modals["can"] = t.raw
        elif nxt is not None and nxt.val == "to":
            if v in ("have", "has", "had", "need", "needs"):
                ex.modals["must"] = f"{t.raw} to"
            elif v in ("ought", "supposed"):
                ex.modals["should"] = f"{t.raw} to"


# --------------------------------------------------------------------------
# check
# --------------------------------------------------------------------------
@dataclass
class Violation:
    rule: str
    original_span: str
    rewrite_span: str
    message: str

    def to_dict(self) -> dict:
        return {"rule": self.rule, "original_span": self.original_span,
                "rewrite_span": self.rewrite_span, "message": self.message}


@dataclass
class GuardResult:
    passed: bool
    violations: list[Violation]
    facts: dict

    def to_dict(self) -> dict:
        return {"pass": self.passed, "violations": [v.to_dict() for v in self.violations], "facts": self.facts}


CONDITIONS = {"if", "unless", "except", "provided"}


def _content(ex: Extraction) -> list[Tok]:
    """Ordered content words: not facts (own rules), not function/discourse words, not -ly adverbs."""
    fact_pos = {f.pos for f in ex.facts}
    skip = STOPWORDS | NEGATIONS | set(QUANT) | set(HEDGE_WORD) | set(HEDGE_NEEDS_NUM) | NUM_WORDS | COMMON_EXTRA
    return [t for t in ex.toks if t.kind == "w" and t.pos not in fact_pos and len(t.val) >= 4
            and t.val not in skip and not t.val.endswith("ly")]


def _stem(w: str) -> str:
    return w[:5]


def _lis(seq: list[int]) -> int:
    tails: list[int] = []
    for x in seq:
        i = bisect.bisect_left(tails, x)
        tails[i:i + 1] = [x]
    return len(tails)


def _content_rules(o: Extraction, r: Extraction) -> list[Violation]:
    """Meaning changes with no number/date/name signal (eval/guard_cases.json cs_*): a dropped multi-word phrase,
    a new item added to a list, or content words rearranged so roles swap ("CS major, business minor")."""
    vs: list[Violation] = []
    oc, rc = _content(o), _content(r)
    o_stems = {_stem(w) for w in o.words}
    r_stems = {_stem(w) for w in r.words}
    ows = [t for t in o.toks if t.kind != "p"]
    # words just before a self-correction marker are allowed to go ("the library, no wait, the gym")
    corrected = {i for ms, _ in _markers(ows) for i in range(max(0, ms - 14), ms)}
    run: list[Tok] = []
    for t in oc + [None]:  # type: ignore[list-item]
        gone = t is not None and _stem(t.val) not in r_stems and t.pos not in corrected
        if gone and (not run or t.pos == run[-1].pos + 1):
            run.append(t)
            continue
        if len(run) >= 2:
            span = " ".join(x.raw for x in run)
            vs.append(Violation("dropped_fact", span, "", f'The rewrite drops "{span}", which you said.'))
        run = [t] if gone else []
    rws = [t for t in r.toks if t.kind != "p"]
    o_cond = [t.raw for t in ows if t.kind == "w" and t.val in CONDITIONS]
    r_cond = [t.raw for t in rws if t.kind == "w" and t.val in CONDITIONS]
    if len(r_cond) < len(o_cond):
        vs.append(Violation("dropped_fact", ", ".join(o_cond), ", ".join(r_cond),
                            f'You set a condition ("{o_cond[0]} ..."), but the rewrite drops it.'))
    content_pos = {t.pos for t in rc}
    for i, t in enumerate(rws):
        if t.kind == "w" and t.val in ("and", "or", "plus"):
            nxt = next((x for x in rws[i + 1:i + 4] if x.pos in content_pos), None)
            if nxt is not None and _stem(nxt.val) not in o_stems:
                vs.append(Violation("invented_fact", "", f"{t.raw} {nxt.raw}",
                                    f'The rewrite adds "{nxt.raw}", which you never said.'))
    first: dict[str, int] = {}
    for i, t in enumerate(oc):
        first.setdefault(_stem(t.val), i)
    seq = [first[_stem(t.val)] for t in rc if _stem(t.val) in first]
    if len(seq) >= 4 and _lis(seq) / len(seq) < 0.6:
        vs.append(Violation("reordered", " ".join(t.raw for t in oc[:8]), " ".join(t.raw for t in rc[:8]),
                            "The rewrite rearranges what you said, so who/what each part refers to may have swapped."))
    return vs


def _wc(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9][A-Za-z0-9'’:.\-]*", text))


def check_rules(original: str, rewrite: str, mode: str = "natural", protected: Iterable[str] = ()) -> GuardResult:
    protected = [p.lower().strip() for p in protected if p and p.strip()]
    o = extract(original)
    r = extract(rewrite, resolve=False)
    vs: list[Violation] = []
    # protected terms are the user's own spelling: allow them in the rewrite, and treat a close ASR
    # mishearing in the original ("Ariane" for "Aryan") as the same word
    prot_words = {w for p in protected for w in re.findall(r"[a-z0-9']+", p)}
    alias = {w: pw for w in o.words for pw in prot_words
             if w != pw and len(pw) >= 3 and w[:1] == pw[:1] and difflib.SequenceMatcher(None, w, pw).ratio() >= 0.7}

    # 1/2: facts (numbers, times, days, months, names)
    for g in r.facts:
        if g.kind == "name":
            if g.key not in o.words and g.key not in prot_words:
                vs.append(Violation("invented_fact", "", g.surface,
                                    f'The rewrite mentions "{g.surface}", who/what you never named.'))
            continue
        if any(_match(g, f) for f in o.final):
            continue
        old = next((f for f in o.superseded if _match(g, f)), None)
        if old is not None:
            vs.append(Violation("superseded_value", old.surface, g.surface,
                                f'You corrected "{old.surface}", but the rewrite still says "{g.surface}".'))
        else:
            vs.append(Violation("invented_fact", "", g.surface,
                                f'The rewrite says "{g.surface}", which you never said.'))
    rwords = r.words
    for f in o.final:
        if f.kind == "name":
            covered = f.key in rwords or alias.get(f.key) in rwords
        else:
            covered = any(_match(f, g) for g in r.facts)
        if not covered:
            vs.append(Violation("dropped_fact", f.surface, "",
                                f'The rewrite drops "{f.surface}", which you said.'))

    # protected terms from the UI
    otext, rtext = original.lower(), rewrite.lower()
    for term in protected:
        if term in otext and term not in rtext:
            vs.append(Violation("protected_term", term, "", f'The protected term "{term}" is missing from the rewrite.'))

    # 3: negation count, and negation moved onto a value you affirmed ("not Thursday" -> "not Friday")
    if len(o.negations) != len(r.negations):
        vs.append(Violation("negation", ", ".join(o.negations), ", ".join(r.negations),
                            f"Negation changed: you used {len(o.negations)}, the rewrite has {len(r.negations)}."))
    for key, span in r.negated.items():
        if key not in o.negated and any(f.kind == key[0] and f.key == key[1] for f in o.final):
            vs.append(Violation("negation", "", span,
                                f'The rewrite negates "{span.split(" ... ")[-1]}", which you did not negate.'))

    # 4: hedges
    for grp, span in o.hedges.items():
        if grp not in r.hedges:
            vs.append(Violation("hedge_dropped", span, "", f'You hedged with "{span}", but the rewrite sounds more certain.'))
    for grp, span in r.hedges.items():
        if grp not in o.hedges:
            vs.append(Violation("hedge_added", "", span, f'The rewrite adds the hedge "{span}", which you did not say.'))

    # 5: quantifiers and modal strength
    for grp in set(o.quantifiers) | set(r.quantifiers):
        if (grp in o.quantifiers) != (grp in r.quantifiers):
            vs.append(Violation("quantifier", o.quantifiers.get(grp, ""), r.quantifiers.get(grp, ""),
                                "A quantifier changed (e.g. everyone/some/none) - the scope of what you said is different."))
    for grp in set(o.modals) | set(r.modals):
        if (grp in o.modals) != (grp in r.modals):
            vs.append(Violation("modal", o.modals.get(grp, ""), r.modals.get(grp, ""),
                                "The strength of a commitment changed (must/should/can)."))

    # content words: dropped phrase, added list item, swapped roles
    vs.extend(_content_rules(o, r))

    # 6: length sanity
    n_o, n_r = _wc(original), _wc(rewrite)
    if n_r:
        lo = 0.25 if mode == "presenter" else 0.3
        if n_o >= 5 and n_r < lo * n_o:
            vs.append(Violation("length", "", "", f"The rewrite is far shorter than what you said ({n_r} vs {n_o} words)."))
        if n_r > max(1.3 * n_o, n_o + 3):
            vs.append(Violation("length", "", "", f"The rewrite is far longer than what you said ({n_r} vs {n_o} words)."))

    summary = {
        "original_final": [f.surface for f in o.final],
        "superseded": [f.surface for f in o.superseded],
        "rewrite": [f.surface for f in r.facts],
    }
    return GuardResult(not vs, vs, summary)


_VERIFY_TEXT = {
    "meaning_preserved": "The AI verifier is not confident the rewrite keeps your meaning.",
    "added_new_information": "The AI verifier thinks the rewrite adds information you did not say.",
    "dropped_hedge_or_uncertainty": "The AI verifier thinks the rewrite removes uncertainty you expressed.",
    "changed_commitment_strength": "The AI verifier thinks the rewrite changes how firmly you committed.",
    "changed_number_date_or_name": "The AI verifier thinks a number, date, time or name changed.",
    "negation_changed": "The AI verifier thinks a statement was flipped between yes and no.",
}


async def check(verbatim: str, rewrite: str, mode: str = "natural",
                protected: Iterable[str] = ()) -> models.GuardResult:
    """Orchestrator entry point: local checks, then independent verification when needed.

    Substantive edits require both deterministic checks and an online independent verifier. A deterministic
    failure is final whatever Decisions says. Never raises because the verifier is down.
    """
    from . import decide

    async def verifier():
        try:  # decide.verify has its own 10 s deadline; this is a belt-and-braces cap
            return await asyncio.wait_for(decide.verify(verbatim, rewrite), decide.VERIFY_DEADLINE_S + 1)
        except Exception as e:  # verifier trouble (incl. timeout) must never break the guard
            return decide.Verification(False, note=f"{type(e).__name__}")

    from .rewrite import surface_equivalent
    # Deterministic failures need no paid verifier; exact/surface-only edits need no semantic inference.
    if surface_equivalent(verbatim, rewrite, protected):
        return models.GuardResult(**{"pass": True, "verifier": "offline"})
    det = await asyncio.to_thread(check_rules, verbatim, rewrite, mode, protected)
    violations = [models.Violation(**v.to_dict()) for v in det.violations]
    if violations:
        return models.GuardResult(**{"pass": False, "violations": violations, "verifier": "offline"})
    ver = await verifier()
    online = bool(ver.available)
    if not online:
        violations.append(models.Violation(rule="verification_required",
            message="This edit changes wording and needs an independent verifier. Review it or use the original transcript."))
    elif not ver.ok:
        for name in ver.failures():
            violations.append(models.Violation(rule="decisions_verifier", message=_VERIFY_TEXT.get(name, name)))
    return models.GuardResult(**{
        "pass": not violations,
        "violations": violations,
        "decisions_probs": ver.probs if online else {},
        "verifier": "online" if online else "offline",
    })


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    mode = "natural"
    if "--mode" in args:
        i = args.index("--mode")
        mode = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        print('usage: python -m backend.guard [--mode minimal|natural|presenter] "verbatim" "rewrite"')
        return 2
    res = check_rules(args[0], args[1], mode=mode)
    print("PASS" if res.passed else "FAIL")
    for v in res.violations:
        print(f"  [{v.rule}] {v.message}")
    return 0 if res.passed else 1


if __name__ == "__main__":
    sys.exit(main())
