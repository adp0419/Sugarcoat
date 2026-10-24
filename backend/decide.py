"""OpenAI Decisions analysis + verification (docs/md/05). OWNER: T2.

Decisions classifies / routes / scores; it never rewrites. ``analyze`` runs pass 1
(predicates, register, recommended mode, per-sentence "leave unchanged?") and
``verify`` runs pass 2 (did the rewrite keep the meaning?). Everything goes through
``_call`` so the wire format lives in one place.

When the API is unavailable we return ``available=False`` with a note. We never fake
Decisions output. MOCK is handled by the orchestrator; only the CLI looks at it.

CLI: ``python -m backend.decide "verbatim text"``
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from typing import Any

import httpx

from .config import settings
from .models import Decisions, SentenceDecision

URL = "https://api.openai.com/v1/decisions"
TIMEOUT_S = 15.0
RETRIES = 2
MAX_SENTENCES = 8
KEEP_BELOW = 0.25      # needs_edit probability under this => leave the sentence unchanged
ISSUE_AT = 0.5

_transport: httpx.AsyncBaseTransport | None = None   # tests inject a MockTransport
_sleep = asyncio.sleep

ANALYSIS_PREDICATES = {
    "has_filler": "Does the text contain filler sounds or words such as um, uh, er, ah, or 'you know' used as filler?",
    "has_repetition": "Does the speaker repeat a word or phrase immediately, without adding meaning?",
    "has_self_correction": "Does the speaker correct or retract something they said earlier (for example 'Friday, actually, Monday')?",
    "has_false_start": "Does the speaker begin a sentence or phrase and abandon it before restarting?",
    "is_incomplete_thought": "Does the text end or trail off before the speaker finishes the thought?",
    "contains_hedging": "Does the speaker express uncertainty with words like maybe, probably, I think, around, or might?",
    "is_already_fluent": "Is the text already fluent and clear, with nothing a careful editor would change?",
}
ISSUE_NAMES = {"has_filler": "filler", "has_repetition": "repetition", "has_self_correction": "self_correction",
               "has_false_start": "false_start"}
SENTENCE_PREDICATES = {"needs_edit": "Would a careful editor change anything in this sentence to make it read clearly "
                                     "(remove fillers, repetition, false starts, or self-corrections)?",
                       **{k: ANALYSIS_PREDICATES[k] for k in ISSUE_NAMES}}
VERIFY_PREDICATES = {
    "meaning_preserved": "Does the rewrite say exactly what the original speaker meant, with nothing important lost?",
    "added_new_information": "Does the rewrite contain facts, claims, names, or details that are not in the original?",
    "dropped_hedge_or_uncertainty": "Did the original express uncertainty (maybe, probably, I think, around) that the rewrite removed?",
    "changed_commitment_strength": "Does the rewrite make a weaker or stronger commitment (for example might vs will, should vs must)?",
    "changed_number_date_or_name": "Does the rewrite change, add, or drop any number, date, time, weekday, or name, "
                                   "after honouring the speaker's own self-corrections?",
    "negation_changed": "Is any statement negated in one text but affirmed in the other?",
}
BAD_VERIFY = tuple(k for k in VERIFY_PREDICATES if k != "meaning_preserved")
PRESERVED_MIN = 0.85
BAD_MAX = 0.25

_REGISTER = {
    "type": "choice", "name": "register",
    "instructions": "What register is the speaker using?",
    "choices": [{"value": "casual", "description": "informal, talking to a friend"},
                {"value": "professional", "description": "workplace talk, colleague to colleague"},
                {"value": "announcement", "description": "addressing a group or making an announcement"}],
}
_MODE = {
    "type": "choice", "name": "recommended_mode",
    "instructions": "How much editing suits this speech? Announcements to a group suit presenter. "
                    "Casual, mostly clear speech suits minimal.",
    "choices": [{"value": "minimal", "description": "only remove fillers and repeats; keep the wording"},
                {"value": "natural", "description": "also fix false starts and self-corrections; light grammar"},
                {"value": "presenter", "description": "restructure into crisp announcement sentences"}],
}


class DecisionsUnavailable(Exception):
    """API cannot be used for this job (auth, quota, timeout, gating). Not a bug."""


def _pred(name: str, instructions: str) -> dict:
    return {"type": "predicate", "name": name, "instructions": instructions}


def _enabled() -> bool:
    return bool(settings.DECISIONS_ENABLED and settings.OPENAI_API_KEY.strip())


def _err_info(r: httpx.Response) -> tuple[str, str]:
    try:
        e = r.json().get("error") or {}
        return str(e.get("code") or e.get("type") or ""), str(e.get("message") or "")
    except (ValueError, AttributeError):
        return "", r.text[:200]


async def _call(input_: str, questions: list[dict]) -> list[dict]:
    """POST /v1/decisions and return the ``answers`` list. Only function that knows the wire format."""
    body = {"model": settings.DECISIONS_MODEL, "input": input_, "questions": questions}
    headers = {"Authorization": f"Bearer {settings.OPENAI_API_KEY.strip()}"}
    last: Exception | None = None
    async with httpx.AsyncClient(transport=_transport, timeout=TIMEOUT_S) as http:
        for attempt in range(RETRIES + 1):
            try:
                r = await http.post(URL, json=body, headers=headers)
            except httpx.HTTPError as e:
                last = DecisionsUnavailable(f"network: {type(e).__name__}")
            else:
                if r.status_code == 200:
                    try:
                        answers = r.json()["answers"]
                    except (ValueError, KeyError, TypeError) as e:
                        raise DecisionsUnavailable(f"unexpected response shape ({type(e).__name__})")
                    return answers
                code, msg = _err_info(r)
                if r.status_code in (401, 403, 404) or code == "insufficient_quota" or code == "credit_balance_exhausted":
                    raise DecisionsUnavailable(f"{r.status_code} {code or msg}".strip())
                if r.status_code == 400:
                    raise DecisionsUnavailable(f"400 {code}: {msg}")
                last = DecisionsUnavailable(f"{r.status_code} {code}".strip())
                if r.status_code == 429 or r.status_code >= 500:
                    pass  # transient: back off and retry
            if attempt < RETRIES:
                await _sleep(2.0)
    raise last or DecisionsUnavailable("unknown error")


def _by_name(answers: list[dict]) -> dict[str, dict]:
    out = {}
    for a in answers or []:
        if isinstance(a, dict) and a.get("name"):
            out[a["name"]] = a
    return out


def _prob(a: dict | None) -> float | None:
    """Predicate answer -> probability. Refusals / missing -> None."""
    if not isinstance(a, dict) or a.get("type") == "refusal" or "refusal" in a:
        return None
    for k in ("probability", "prob", "p"):
        v = a.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return max(0.0, min(1.0, float(v)))
    return None


def _choice(a: dict | None, allowed: tuple[str, ...]) -> str | None:
    if not isinstance(a, dict) or a.get("type") == "refusal" or "refusal" in a:
        return None
    v = a.get("choice", a.get("value"))
    if isinstance(v, dict):
        v = v.get("value")
    return v if v in allowed else None


def split_for_decisions(sentences: list[str]) -> list[str]:
    return [s for s in sentences if s and s.strip()]


_FILLER = re.compile(r"\b(um+|uh+|er+|ah+|erm|you know)\b", re.I)
_CORRECT = re.compile(r"\b(actually|sorry|i mean|no wait|scratch that|rather)\b", re.I)


def _rule_issues(sentence: str) -> list[str]:
    """Labelled rule-based hints used ONLY when Decisions is unavailable."""
    out = []
    if _FILLER.search(sentence):
        out.append("filler")
    if _CORRECT.search(sentence):
        out.append("self_correction")
    return out


def _unavailable(sentences: list[str], why: str) -> Decisions:
    return Decisions(
        available=False,
        recommended_mode="natural",
        per_sentence=[SentenceDecision(index=i, text=s, keep=False, issues=_rule_issues(s))
                      for i, s in enumerate(sentences)],
        note=f"Decisions API unavailable ({why}). Defaulting to Natural; issue hints are rule-based, not AI.",
    )


async def _sentence_pass(i: int, s: str) -> SentenceDecision:
    qs = [_pred(n, ins) for n, ins in SENTENCE_PREDICATES.items()]
    by = _by_name(await _call(s, qs))
    need = _prob(by.get("needs_edit"))
    issues = [label for key, label in ISSUE_NAMES.items() if (_prob(by.get(key)) or 0.0) >= ISSUE_AT]
    return SentenceDecision(index=i, text=s, keep=(need is not None and need < KEEP_BELOW),
                            issues=issues, needs_edit_prob=need)


async def analyze(verbatim: str, sentences: list[str]) -> Decisions:
    """Pass 1. Never raises for API trouble: returns ``Decisions(available=False, ...)``."""
    sents = split_for_decisions(sentences) or [verbatim]
    if not _enabled():
        why = "DECISIONS_ENABLED=0" if not settings.DECISIONS_ENABLED else "no OPENAI_API_KEY"
        return _unavailable(sents, why)
    qs = [_pred(n, ins) for n, ins in ANALYSIS_PREDICATES.items()] + [_REGISTER, _MODE]
    try:
        by = _by_name(await _call(verbatim, qs))
        preds = {n: p for n in ANALYSIS_PREDICATES if (p := _prob(by.get(n))) is not None}
        register = _choice(by.get("register"), ("casual", "professional", "announcement")) or "casual"
        mode = _choice(by.get("recommended_mode"), ("minimal", "natural", "presenter")) or "natural"
        per: list[SentenceDecision]
        if len(sents) <= MAX_SENTENCES:
            results = await asyncio.gather(*(_sentence_pass(i, s) for i, s in enumerate(sents)),
                                           return_exceptions=True)
            per = [r if isinstance(r, SentenceDecision) else SentenceDecision(index=i, text=sents[i])
                   for i, r in enumerate(results)]
        else:  # beyond 8 sentences: skip per-sentence (docs/md/05)
            per = [SentenceDecision(index=i, text=s) for i, s in enumerate(sents)]
        return Decisions(available=True, predicates=preds, register=register, recommended_mode=mode,
                         per_sentence=per,
                         note=None if len(sents) <= MAX_SENTENCES else "More than 8 sentences: per-sentence pass skipped.")
    except DecisionsUnavailable as e:
        return _unavailable(sents, str(e))


class Verification:
    """Pass-2 result: probabilities + verdict. ``available=False`` => deterministic only."""

    def __init__(self, available: bool, probs: dict[str, float] | None = None, note: str | None = None):
        self.available, self.probs, self.note = available, probs or {}, note

    @property
    def ok(self) -> bool:
        p = self.probs.get("meaning_preserved")
        return (p is not None and p >= PRESERVED_MIN
                and all(self.probs.get(k, 0.0) <= BAD_MAX for k in BAD_VERIFY))

    def failures(self) -> list[str]:
        out = []
        p = self.probs.get("meaning_preserved")
        if p is not None and p < PRESERVED_MIN:
            out.append("meaning_preserved")
        out += [k for k in BAD_VERIFY if self.probs.get(k, 0.0) > BAD_MAX]
        return out


async def verify(original: str, rewrite: str) -> Verification:
    """Pass 2: ask Decisions whether ``rewrite`` kept the meaning of ``original``."""
    if not _enabled():
        return Verification(False, note="Decisions disabled")
    payload = json.dumps({"original": original, "rewrite": rewrite}, ensure_ascii=False)
    try:
        by = _by_name(await _call(payload, [_pred(n, ins) for n, ins in VERIFY_PREDICATES.items()]))
    except DecisionsUnavailable as e:
        return Verification(False, note=str(e))
    probs = {n: p for n in VERIFY_PREDICATES if (p := _prob(by.get(n))) is not None}
    if "meaning_preserved" not in probs:
        return Verification(False, probs, note="verifier returned no meaning_preserved answer")
    return Verification(True, probs)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print('usage: python -m backend.decide "verbatim text"')
        return 2
    text = " ".join(args)
    if settings.MOCK:
        print((settings.fixtures_dir / "decisions_canonical.json").read_text())
        return 0
    from .split import split_sentences

    res = asyncio.run(analyze(text, split_sentences(text)))
    print(json.dumps(res.model_dump(), indent=2))
    return 0 if res.available else 1


if __name__ == "__main__":
    sys.exit(main())
