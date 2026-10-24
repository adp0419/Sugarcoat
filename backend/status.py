"""Last known provider account status, from real calls only (health must not spend credits).

Gemini's free metadata calls (models.get, count_tokens) succeed on a key with no credits (checked
2026-10-24), so the only honest signal is the error from the most recent real call. Persisted to
cache/provider_status.json once the app starts (`enable_persist`) so a restart still remembers it.
"""
import json
import logging
import re
import time

from .config import settings

log = logging.getLogger("voiceflow.status")

_last: dict[str, dict] = {}
_persist = False


def _path():
    return settings.cache_dir / "provider_status.json"


def enable_persist() -> None:
    global _persist
    _persist = True
    try:
        _last.update(json.loads(_path().read_text()))
    except (OSError, ValueError):
        pass


def record(provider: str, state: str, detail: str = "") -> None:
    """state: ok | no_credits | auth_error | error. Detail must never contain a key."""
    prev = _last.get(provider, {}).get("state")
    _last[provider] = {"state": state, "detail": detail[:200], "at": time.time()}
    if prev != state:
        log.info("%s status: %s %s", provider, state, detail[:120])
    if _persist:
        try:
            _path().parent.mkdir(parents=True, exist_ok=True)
            _path().write_text(json.dumps(_last, indent=1))
        except OSError:
            pass


def get(provider: str) -> str | None:
    return _last.get(provider, {}).get("state")


def recent(provider: str, max_age_s: float) -> str | None:
    """State only if recorded within max_age_s (so a skip based on it re-probes after a while)."""
    e = _last.get(provider)
    return e["state"] if e and time.time() - e.get("at", 0) <= max_age_s else None


def from_decisions_note(note: str | None) -> str | None:
    """Classify decide.py's 'Decisions API unavailable (<why>)' note. None = not an account problem."""
    n = (note or "").lower()
    if "credit_balance_exhausted" in n or "insufficient_quota" in n:
        return "no_credits"
    if re.search(r"\((?:401|403)\b", n) or "invalid_api_key" in n:
        return "auth_error"
    return None
