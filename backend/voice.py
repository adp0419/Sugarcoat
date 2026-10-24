"""Twinly speak (docs/md/04). OWNER: T2. T1 stub — replace the body, keep the signature."""
from .models import SpeakResponse


async def speak(text: str) -> SpeakResponse:
    """Pack text into <=550-char chunks (never mid-sentence), max 2 concurrent Twinly jobs, cache by
    sha256(text+voice) in settings.cache_dir as {hash}.m4a, return chunks with url="/api/audio/{hash}.m4a".

    Never retry POST after 503 job_unverified. Raise api_error(...) from backend.errors for
    twinly_offline / voice_not_set_up / rate_limited / job_unverified.
    Also expose `async def health() -> TwinlyHealth` (GET /v1/me, cached 30 s) for /api/health.
    """
    raise NotImplementedError("T2: voice.speak")


async def health():
    """Return backend.models.TwinlyHealth. T2 implements; stub reports offline."""
    from .models import TwinlyHealth
    return TwinlyHealth(online=False, voice_ready=False)
