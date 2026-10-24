"""Rewrite stage: Gemma 4 via the Gemini API (docs/md/06) + deterministic minimal-filler rung.

CLI: python -m backend.rewrite --mode natural "um so Friday actually Monday at five"
"""
import argparse
import asyncio
import difflib
import json
import logging
import re

from .config import settings
from .errors import api_error
from .models import Decisions, Edit, Mode, RewriteResult

log = logging.getLogger("voiceflow.rewrite")

FALLBACK_MODEL = "gemma-4-31b-it"
RETRY_BACKOFF_S = 2

SYSTEM = """You EDIT speech transcripts, you do not compose. Output must use the speaker's own words wherever possible.
Preserve: every date, time, number, name, place; negations (not, never, n't); hedges (maybe, probably, I think, might, around);
commitments (will vs might); quantifiers (all, everyone, some, most).
Self-corrections: keep only the final corrected value. Never keep both.
Never add facts, greetings, sign-offs, or politeness that were not spoken.
Convert to announcement voice only in PRESENTER mode.
Sentences marked LEAVE_UNCHANGED must be returned exactly.
If unsure, change less.

Modes:
- MINIMAL: delete fillers (um, uh, you know) and duplicated words only. Wording otherwise unchanged.
- NATURAL: also fix false starts, self-corrections and light grammar. Same register.
- PRESENTER: also restructure into crisp announcement sentences. Still no new facts.

Return ONLY valid JSON, no prose, no code fences:
{"rewrite": "<full edited text>", "edits": [{"from": "<exact span of the original>", "to": "<replacement or empty>", "reason": "<filler|repetition|self_correction|false_start|grammar|restructure>"}]}

Examples
MODE: NATURAL
VERBATIM: So um we should meet on Tuesday, no wait, Wednesday at 3.
{"rewrite": "We should meet on Wednesday at 3.", "edits": [{"from": "So um ", "to": "", "reason": "filler"}, {"from": "Tuesday, no wait, ", "to": "", "reason": "self_correction"}]}

MODE: MINIMAL
VERBATIM: I I think we might meet around 5, uh, maybe.
{"rewrite": "I think we might meet around 5, maybe.", "edits": [{"from": "I ", "to": "", "reason": "repetition"}, {"from": "uh, ", "to": "", "reason": "filler"}]}

MODE: PRESENTER
VERBATIM: We're, uh, not going to have the party on Thursday, everybody should know that.
{"rewrite": "We are not having the party on Thursday. Everybody should know that.", "edits": [{"from": "We're, uh, not going to have", "to": "We are not having", "reason": "restructure"}, {"from": ", everybody", "to": ". Everybody", "reason": "restructure"}]}"""

_client = None


def _get_client():
    global _client
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=settings.GEMINI_API_KEY)
    return _client


def build_prompt(verbatim: str, mode: Mode, decisions: Decisions | None = None,
                 sentences: list[str] | None = None, violations: list[str] | None = None,
                 protected: list[str] | None = None) -> str:
    parts = [f"MODE: {mode.upper()}"]
    if protected:
        parts.append("PROTECTED TERMS (spell exactly like this; the transcript may mishear them): " + ", ".join(protected))
    if decisions and decisions.available:
        issues = sorted({i for s in decisions.per_sentence for i in s.issues})
        parts.append("ISSUES (from analysis): " + (", ".join(issues) or "none"))
        if decisions.per_sentence:
            lines = [f"[{s.index}] {'LEAVE_UNCHANGED ' if s.keep else ''}{s.text}" for s in decisions.per_sentence]
            parts.append("SENTENCES:\n" + "\n".join(lines))
    if violations:
        parts.append("STRICT RETRY. Your previous rewrite was rejected for these reasons; do not repeat them. "
                     "Change as little as possible and keep every date, time, number, negation, hedge and quantifier:\n- "
                     + "\n- ".join(violations))
    parts.append(f"VERBATIM: {verbatim}")
    return "\n".join(parts)


def parse(raw: str) -> RewriteResult:
    s = raw.strip()
    s = re.sub(r"^```(?:json)?\s*|\s*```$", "", s, flags=re.I)
    if not s.startswith("{"):  # tolerate leading prose
        i, j = s.find("{"), s.rfind("}")
        s = s[i:j + 1] if i >= 0 and j > i else s
    return RewriteResult.model_validate(json.loads(s))


async def _generate(prompt: str, model: str) -> str:
    r = await _get_client().aio.models.generate_content(
        model=model, contents=prompt, config={"system_instruction": SYSTEM, "temperature": 0})
    return r.text or ""


_RATE_LIMITED = ("429", "503", "RESOURCE_EXHAUSTED", "UNAVAILABLE")
_SERVER_ERROR = ("500", "INTERNAL")


async def _call(prompt: str, deadline: float) -> tuple[str, str]:
    """At most two attempts, all inside one time budget (`deadline`, loop clock). Returns (raw, model_used).

    Measured 2026-10-24: Gemma 4 on the Gemini API answers short inputs in ~16 s, returns 500 INTERNAL
    instantly on some longer ones, and sometimes never answers. So: per-call timeout, one retry for
    500/timeouts on the same model, 429/503 -> the 31b model; never past the budget.
    """
    loop = asyncio.get_running_loop()
    model, last = settings.GEMMA_MODEL, None
    for attempt in range(2):
        left = deadline - loop.time()
        if left < 1:
            break
        try:
            return await asyncio.wait_for(_generate(prompt, model), min(settings.GEMMA_TIMEOUT_S, left)), model
        except Exception as e:
            last = e
            msg = str(e)
            timeout = isinstance(e, asyncio.TimeoutError)
            if not (timeout or any(c in msg for c in _RATE_LIMITED + _SERVER_ERROR)):
                raise
            log.warning("gemma %s attempt %d failed: %s", model, attempt + 1, "timeout" if timeout else msg[:80])
            if any(c in msg for c in _RATE_LIMITED):
                model = FALLBACK_MODEL
                await asyncio.sleep(min(RETRY_BACKOFF_S, max(0.0, deadline - loop.time() - 1)))
    if isinstance(last, asyncio.TimeoutError) or last is None:
        raise TimeoutError(f"Gemma did not answer within {settings.GEMMA_BUDGET_S:.0f} s")
    raise last


def _words(t: str) -> int:
    return len(t.split())


def sanity(verbatim: str, res: RewriteResult, mode: Mode) -> str | None:
    """Return a failure reason or None. Docs 06 'Failure modes'."""
    if not res.rewrite.strip():
        return "rewrite is empty"
    if _words(res.rewrite) > 1.3 * _words(verbatim) + 1:
        return "rewrite is longer than the original (hallucination signal)"
    if mode != "minimal" and res.rewrite.strip() == verbatim.strip() and _FILLER_RE.search(verbatim):
        return "rewrite is unchanged although fillers exist"
    return None


def clean_edits(verbatim: str, res: RewriteResult) -> RewriteResult:
    """Don't trust the model's edits alone: keep those whose `from` appears in the verbatim text; if none
    survive but the text changed, derive edits from a token diff."""
    low = verbatim.lower()
    kept = [e for e in res.edits if e.from_ and e.from_.lower() in low]
    if not kept and res.rewrite.strip() != verbatim.strip():
        kept = diff_edits(verbatim, res.rewrite)
    return RewriteResult(rewrite=res.rewrite.strip(), edits=kept)


def diff_edits(a: str, b: str) -> list[Edit]:
    aw, bw = a.split(), b.split()
    out: list[Edit] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, aw, bw, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        frm, to = " ".join(aw[i1:i2]), " ".join(bw[j1:j2])
        reason = "filler" if _FILLER_RE.fullmatch(re.sub(r"\W", "", frm).lower() or "x") else ("restructure" if to else "filler")
        out.append(Edit(**{"from": frm, "to": to, "reason": reason}))
    return out


async def run(verbatim: str, mode: Mode, decisions: Decisions | None = None,
              violations: list[str] | None = None, protected: list[str] | None = None) -> tuple[RewriteResult, str]:
    """Gemma rewrite. Returns (result, model_used). Raises on failure so the orchestrator takes the next rung."""
    if not settings.GEMINI_API_KEY:
        raise api_error("internal", "GEMINI_API_KEY is not set", "Add it to .env or run with MOCK=1.")
    deadline = asyncio.get_running_loop().time() + settings.GEMMA_BUDGET_S
    prompt = build_prompt(verbatim, mode, decisions, violations=violations, protected=protected)
    raw, model = await _call(prompt, deadline)
    try:
        res = parse(raw)
    except Exception:
        raw, model = await _call(prompt + "\n\nReturn ONLY valid JSON.", deadline)
        res = parse(raw)  # second failure propagates -> ladder
    bad = sanity(verbatim, res, mode)
    if bad:
        raise ValueError(bad)
    return clean_edits(verbatim, res), model


# ---- deterministic rung 2 ----
_FILLER_WORDS = r"(?:u+m+|u+h+|e+r+m?|a+h+|h+m+|mm+|you know|i mean)"
_FILLER_RE = re.compile(rf"^{_FILLER_WORDS}$", re.I)
_FILLER_SPAN = re.compile(rf"(?:,\s*)?(?<![\w'-])(?:{_FILLER_WORDS}|like(?=,))\b[,.]?\s*", re.I)
_STUTTER = re.compile(r"\b(\w+)-\s*(?=\1\b)", re.I)  # "I- I want" -> "I want"
_REPEAT = re.compile(r"\b(\w+)(\s*,?\s+\1\b)+", re.I)  # "the the" -> "the"


def minimal(verbatim: str) -> RewriteResult:
    """Regex-remove fillers, collapse immediate repeats, fix spacing/capitalisation. No LLM."""
    edits: list[Edit] = []
    text = verbatim

    def sub(rx, reason, repl=lambda m: ""):
        nonlocal text
        def f(m):
            r = repl(m)
            edits.append(Edit(**{"from": m.group(0), "to": r.strip(), "reason": reason}))
            return r
        text = rx.sub(f, text)

    sub(_FILLER_SPAN, "filler", lambda m: " " if m.group(0).startswith(",") else "")
    sub(_STUTTER, "repetition", lambda m: "")
    sub(_REPEAT, "repetition", lambda m: m.group(1))
    text = re.sub(r"\s+([,.!?])", r"\1", text)
    text = re.sub(r"([,.!?])(?=\w)", r"\1 ", text)
    text = re.sub(r"^[\s,]+|\s{2,}", lambda m: "" if m.start() == 0 else " ", text).strip()
    text = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)
    return RewriteResult(rewrite=text, edits=edits)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="natural", choices=["minimal", "natural", "presenter"])
    ap.add_argument("--offline", action="store_true", help="deterministic minimal rung only")
    ap.add_argument("text")
    a = ap.parse_args()
    if a.offline:
        print(minimal(a.text).model_dump_json(by_alias=True, indent=1))
    else:
        r, m = asyncio.run(run(a.text, a.mode))
        print(m, r.model_dump_json(by_alias=True, indent=1))
