"""ASR stage: ffmpeg convert + CrisperWhisper verbatim (docs/md/07).

CLI: python -m backend.asr path/to/audio
"""
import asyncio
import logging
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import settings
from .errors import api_error
from .models import ASRResult, Word

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # must be set before torch loads

log = logging.getLogger("voiceflow.asr")

_model = None
_pool = ThreadPoolExecutor(max_workers=1)  # one worker: model memory
SILENCE_DB = -50.0


PAUSE_SPLIT_S = 0.7


def split_sentences(verbatim: str, words: list[Word] | None = None) -> list[str]:
    """Split on [.?!], then on pauses > 0.7 s between word timestamps (docs/md/03)."""
    if words and " ".join(w.w for w in words).split() == verbatim.split():
        out, cur = [], []
        for i, w in enumerate(words):
            cur.append(w.w)
            gap = words[i + 1].start - w.end if i + 1 < len(words) else 0.0
            if re.search(r"[.?!][\"')\]]*$", w.w) or gap > PAUSE_SPLIT_S:
                out.append(" ".join(cur))
                cur = []
        if cur:
            out.append(" ".join(cur))
        return [x for x in out if x.strip()]
    return [x.strip() for x in re.split(r"(?<=[.?!])\s+", verbatim) if x.strip()]


def loaded() -> bool:
    return _model is not None


def _load_sync():
    global _model
    from crisperwhisper import CrisperWhisperModel

    t = time.time()
    import torch

    # Measured 2026-10-23 on M-series: MPS+float16 transcribes the 9 s canonical clip in ~3 s (CPU "auto" was minutes).
    if torch.backends.mps.is_available():
        _model = CrisperWhisperModel(settings.ASR_SIZE, device="mps", compute_type="float16")
    else:
        _model = CrisperWhisperModel(settings.ASR_SIZE)
    log.info("CrisperWhisper(%s) loaded in %.1fs", settings.ASR_SIZE, time.time() - t)


async def load() -> None:
    """Load once at startup, then warm up with 1 s of silence."""
    if _model is None:
        await asyncio.get_running_loop().run_in_executor(_pool, _load_sync)
    try:
        import numpy as np
        await asyncio.get_running_loop().run_in_executor(
            _pool, lambda: _model.transcribe(np.zeros(16000, dtype="float32"), sr=16000, mode="verbatim"))
    except Exception as e:  # warm-up is best effort
        log.warning("ASR warm-up failed: %s", e)


async def _run(*args: str) -> tuple[int, str]:
    p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    out, _ = await p.communicate()
    return p.returncode, out.decode(errors="replace")


async def convert(src: Path, dst: Path, max_seconds: float | None = None) -> None:
    """Any browser format -> 16 kHz mono wav (optionally only the first `max_seconds`)."""
    cap = ["-t", str(max_seconds)] if max_seconds else []
    rc, out = await _run("ffmpeg", "-y", "-loglevel", "error", "-i", str(src), *cap, "-ar", "16000", "-ac", "1", str(dst))
    if rc != 0 or not dst.exists():
        raise api_error("asr_failed", "Could not read the recording.", "Try recording again (Chrome or Safari).")


async def mean_volume_db(wav: Path) -> float | None:
    rc, out = await _run("ffmpeg", "-i", str(wav), "-af", "volumedetect", "-f", "null", "-")
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", out)
    return float(m.group(1)) if m else None  # None => no audio samples at all


def _repeated_ngrams(text: str, n: int = 3) -> bool:
    """Whisper-on-silence hallucination signal: the same n-gram repeating >=3 times."""
    w = re.findall(r"[\w']+", text.lower())
    seen: dict[tuple, int] = {}
    for i in range(len(w) - n + 1):
        g = tuple(w[i:i + n])
        seen[g] = seen.get(g, 0) + 1
        if seen[g] >= 3:
            return True
    return False


_TAG = re.compile(r"\[([A-Za-z]+)\]")


def clean_tags(text: str) -> str:
    """CrisperWhisper marks disfluencies as "[UM]" / "[UH]"; normalise to plain lowercase "um" / "uh"."""
    return _TAG.sub(lambda m: m.group(1).lower(), text)


def _transcribe_sync(wav: Path) -> ASRResult:
    r = _model.transcribe(str(wav), language="en", mode="verbatim", word_timestamps=True)
    words = [Word(w=clean_tags(w.word), start=w.start or 0.0, end=w.end or 0.0) for w in (r.words or [])]
    return ASRResult(text=clean_tags(r.text or "").strip(), words=words, seconds=float(r.duration or 0.0))


async def transcribe(wav: Path) -> ASRResult:
    """RMS gate -> CrisperWhisper in the executor -> hallucination gate. Raises ApiError no_speech/asr_failed."""
    db = await mean_volume_db(wav)
    if db is None or db < SILENCE_DB:
        raise api_error("no_speech", "Couldn't hear anything.", "Check your microphone and try again.")
    if _model is None:
        await load()
    try:
        res = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(_pool, _transcribe_sync, wav), 60)
    except asyncio.TimeoutError:
        raise api_error("asr_failed", "Transcription timed out.", "Try a shorter recording.")
    except Exception as e:
        log.exception("ASR failed")
        raise api_error("asr_failed", f"Transcription failed: {type(e).__name__}", "Try again; see server log.")
    if not res.text.strip() or _repeated_ngrams(res.text):
        raise api_error("no_speech", "Couldn't hear anything.", "Speak closer to the mic and try again.")
    return res


async def process_upload(src: Path, work: Path) -> tuple[ASRResult, int]:
    """convert + transcribe; deletes audio files afterwards unless KEEP_AUDIO=1. Returns (result, convert_ms)."""
    wav = work.with_suffix(".wav")
    try:
        t = time.time()
        await convert(src, wav)
        conv_ms = int((time.time() - t) * 1000)
        return await transcribe(wav), conv_ms
    finally:
        if not settings.KEEP_AUDIO:
            for p in (src, wav):
                p.unlink(missing_ok=True)


if __name__ == "__main__":
    async def _main():
        p = Path(sys.argv[1])
        wav = p if p.suffix == ".wav" else Path("/tmp/vf_cli.wav")
        if wav != p:
            await convert(p, wav)
        t = time.time()
        r = await transcribe(wav)
        print(r.model_dump_json(indent=1), f"\n{time.time()-t:.1f}s")
    asyncio.run(_main())
