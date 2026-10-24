"""OpenAI Decisions analysis (docs/md/05). OWNER: T2. T1 stub — replace the body, keep the signature."""
from .models import Decisions


async def analyze(verbatim: str, sentences: list[str]) -> Decisions:
    """Pass 1: predicates (has_filler, has_self_correction, is_already_fluent, ...), register,
    recommended_mode, plus per-sentence needs_edit (<=8 sentences, concurrent).

    On 401/403/404/timeout or DECISIONS_ENABLED=0: return Decisions(available=False, note=..., recommended_mode="natural").
    Do not fake output. MOCK is handled by the orchestrator; do not branch on it here.
    """
    raise NotImplementedError("T2: decide.analyze")
