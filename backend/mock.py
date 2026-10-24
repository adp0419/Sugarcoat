"""MOCK=1 stand-ins for every network/model stage, reading fixtures/ with 300-800 ms sleeps (docs/md/10)."""
import asyncio
import json
import random

from .config import settings
from .models import ASRResult, AudioChunk, Decisions, GuardResult, RewriteResult, SpeakResponse, Violation

BACKUP_NAME = "backup_demo.m4a"
BACKUP_SECONDS = 3.84  # ffprobe of fixtures/backup_demo.m4a (owner's cloned voice, canonical line)
LIVE_WORDS_PER_SEQ = 6  # /api/live: each tick reveals ~6 more words (~2 words/s at a 3 s interval)


def _load(name: str):
    return json.loads((settings.fixtures_dir / name).read_text())


async def _nap():
    await asyncio.sleep(random.uniform(0.3, 0.8))


# stage mode: segment N hears sentence N (wrapping), so a session plays out like a short talk
STAGE_SEGMENTS = (
    "So, um, the team meeting is on Monday at 5 PM.",
    "Uh, everyone should, um, bring their laptops.",
    "The demo is on Friday, actually, sorry, Saturday at noon.",
    "And, uh, lunch is on me.",
)


def segment_text(segment: int) -> str:
    return STAGE_SEGMENTS[segment % len(STAGE_SEGMENTS)]


def asr_text() -> str:
    return _load("asr_canonical.json")["text"]


async def asr() -> ASRResult:
    await _nap()
    return ASRResult(**_load("asr_canonical.json"))


async def decide() -> Decisions:
    await _nap()
    return Decisions(**_load("decisions_canonical.json"))


async def rewrite(mode: str) -> RewriteResult:
    await _nap()
    return RewriteResult(**_load(f"rewrite_{mode}.json"))


async def guard(verbatim: str, rewrite_text: str) -> GuardResult:
    """Tiny canned guard: enough to demo the Friday->Monday block without T2's real guard."""
    await _nap()
    ok = GuardResult(**_load("guard_pass.json"))
    low, vlow = rewrite_text.lower(), verbatim.lower()
    if "friday" in vlow and "actually" in vlow and "friday" in low:
        return GuardResult(
            **{"pass": False, "verifier": "online", "decisions_probs": {"meaning_preserved": 0.2, "changed_number_date_or_name": 0.96},
               "violations": [Violation(rule="superseded_value", original_span="Friday—actually, sorry, Monday",
                                        rewrite_span="Friday", message="You corrected Friday to Monday, but the rewrite says Friday.")]})
    if not rewrite_text.strip():
        return ok.model_copy(update={"pass_": False, "violations": [Violation(rule="empty", message="The rewrite is empty.")]})
    return ok


async def nap_speak() -> None:
    await asyncio.sleep(random.uniform(0.6, 1.2))


async def speak(text: str) -> SpeakResponse:
    await nap_speak()
    secs = BACKUP_SECONDS
    return SpeakResponse(chunks=[AudioChunk(url=f"/api/audio/{BACKUP_NAME}", seconds=secs, cached=False)],
                         total_seconds=secs, ms=800)
