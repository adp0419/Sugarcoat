"""Meaning guard (docs/md/08). OWNER: T2. T1 stub — replace the body, keep the signature.

CLI: python -m backend.guard "<verbatim>" "<rewrite>"
"""
from .models import GuardResult


async def check(verbatim: str, rewrite: str) -> GuardResult:
    """Deterministic fact/negation/hedge/quantifier/length checks + Decisions verifier (in parallel).

    Deterministic violation => pass_=False regardless of Decisions. If Decisions is unavailable,
    return verifier="offline" (deterministic only). Never raises for a failed check; raise only on bugs.
    """
    raise NotImplementedError("T2: guard.check")
