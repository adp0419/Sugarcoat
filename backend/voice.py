"""Twinly speak (docs/md/04). OWNER: T2.

``speak(text)`` packs text into <=550-char chunks, sends them to Twinly's
``POST /v1/voice/speak`` (2 concurrent, <=30 req/min), caches audio by
sha256(text + voice) and returns ordered chunks. A 503 ``job_unverified`` is
never retried: the job may have run and been billed.

CLI: ``python -m backend.voice "text"`` (set MOCK=1 to skip the network).
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import os
import shutil
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from . import split
from .config import settings
from .errors import api_error
from .models import AudioChunk, SpeakResponse, TwinlyHealth

CHUNK_CHARS = 550          # packer limit (Twinly accepts <=600)
MAX_TOTAL_CHARS = 2400
MAX_CONCURRENT = 2
RATE_PER_MIN = 30
JOB_TIMEOUT_S = 60.0
RENDER_BUDGET_S = 55.0     # main.py cancels voice.speak at 60 s; never start an attempt that can't finish
LINE_COST_USD = 0.10
SPEND_CAP_LINES = 150
HEALTH_TTL_S = 30.0

_TERMINAL_FAIL = {"failed", "canceled", "expired"}


class _VoiceStarting(Exception):
    """Twinly's voice engine is still warming up; the speak job should be re-posted."""


def _find(obj: Any, key: str):
    """First value stored under ``key`` anywhere in a JSON-ish structure."""
    if isinstance(obj, dict):
        if key in obj and obj[key] not in (None, ""):
            return obj[key]
        for v in obj.values():
            r = _find(v, key)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find(v, key)
            if r is not None:
                return r
    return None


def _json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return {}


def _error_code(resp: httpx.Response) -> str:
    j = _json(resp)
    if isinstance(j, dict):
        err = j.get("error")
        if isinstance(err, dict):
            return str(err.get("code") or err.get("type") or "")
        if isinstance(err, str):
            return err
        return str(j.get("code") or "")
    return ""


class _RateLimiter:
    """Sliding window: at most ``per_min`` acquisitions in any 60 s."""

    def __init__(self, per_min: int, clock: Callable[[], float], sleep: Callable[[float], Awaitable]):
        self.per_min, self.clock, self.sleep = per_min, clock, sleep
        self.stamps: deque[float] = deque()
        self.lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self.lock:
            while True:
                now = self.clock()
                while self.stamps and now - self.stamps[0] >= 60:
                    self.stamps.popleft()
                if len(self.stamps) < self.per_min:
                    self.stamps.append(now)
                    return
                await self.sleep(60 - (now - self.stamps[0]) + 0.01)


class TwinlyClient:
    def __init__(self, key: str, base: str, cache_dir: Path, *, transport: httpx.AsyncBaseTransport | None = None,
                 sleep: Callable[[float], Awaitable] = asyncio.sleep, clock: Callable[[], float] = time.monotonic,
                 spend_path: Path | None = None, allow_spend: bool = False):
        self.key = key.strip()
        self.base = base.strip().rstrip("/")
        self.cache_dir = cache_dir
        self.sleep = sleep
        self.clock = clock
        self.voice_id = "own-" + hashlib.sha256(self.key.encode()).hexdigest()[:10]  # keyed to the account
        self.spend_path = spend_path
        self.allow_spend = allow_spend
        self.sem = asyncio.Semaphore(MAX_CONCURRENT)
        self.limiter = _RateLimiter(RATE_PER_MIN, clock, sleep)
        self.http = httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(40.0, connect=10.0),
                                      headers={"Authorization": f"Bearer {self.key}"})
        self._health: tuple[float, TwinlyHealth] | None = None
        self.in_flight = 0
        self.max_in_flight = 0

    async def aclose(self) -> None:
        await self.http.aclose()

    # ---- cache ---------------------------------------------------------
    def chunk_hash(self, text: str) -> str:
        return hashlib.sha256(f"{text}\x00{self.voice_id}".encode()).hexdigest()

    def _paths(self, h: str) -> tuple[Path, Path]:
        return self.cache_dir / f"{h}.m4a", self.cache_dir / f"{h}.json"

    def _cached(self, h: str) -> AudioChunk | None:
        audio, meta = self._paths(h)
        if not audio.exists() or audio.stat().st_size == 0:
            return None
        try:
            secs = float(json.loads(meta.read_text())["seconds"])
        except (OSError, ValueError, KeyError):
            secs = 0.0
        return AudioChunk(url=f"/api/audio/{h}.m4a", seconds=secs, cached=True)

    def _store(self, h: str, audio: bytes, seconds: float) -> AudioChunk:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        path, meta = self._paths(h)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(audio)
        tmp.replace(path)
        meta.write_text(json.dumps({"seconds": seconds}))
        return AudioChunk(url=f"/api/audio/{h}.m4a", seconds=seconds, cached=False)

    # ---- spend ---------------------------------------------------------
    def _spend_state(self) -> dict:
        if not self.spend_path:
            return {"lines": 0, "usd": 0.0}
        try:
            return json.loads(self.spend_path.read_text())
        except (OSError, ValueError):
            return {"lines": 0, "usd": 0.0}

    def _spend_check(self) -> None:
        if not self.allow_spend and self._spend_state()["lines"] >= SPEND_CAP_LINES:
            raise api_error("rate_limited", f"Spend cap reached ({SPEND_CAP_LINES} lines).",
                            "Set ALLOW_SPEND=1 to continue.")

    def _spend_add(self) -> None:
        if not self.spend_path:
            return
        st = self._spend_state()
        st["lines"] = int(st.get("lines", 0)) + 1
        st["usd"] = round(float(st.get("usd", 0.0)) + LINE_COST_USD, 2)
        self.spend_path.parent.mkdir(parents=True, exist_ok=True)
        self.spend_path.write_text(json.dumps(st))

    # ---- http ----------------------------------------------------------
    def _raise_for(self, resp: httpx.Response, code: str):
        s = resp.status_code
        if code == "voice_not_set_up":
            return api_error("voice_not_set_up", "Your Twinly voice clone isn't set up.",
                             "In the Twinly app: Voice screen > Build my clone, then retry.")
        if s == 409 or code == "twinly_offline":
            return api_error("twinly_offline", "Twinly is offline.",
                             "Wake the Mac, open the Twinly app, then try again (caffeinate -d).")
        if code == "job_unverified":
            return api_error("job_unverified", "Twinly could not confirm whether the line was spoken.",
                             "Check the Twinly app before retrying. VoiceFlow will not resend automatically.")
        if code == "origin_not_allowed" or s == 403:
            return api_error("internal", "Twinly refused the request origin.", "Calls must come from the backend.")
        if s in (401,):
            return api_error("internal", "Twinly rejected the API key.", "Check TWINLY_API_KEY in .env.")
        if code == "voice_failed":
            return api_error("internal", "Twinly failed to render the voice.", "Retry once; check the Twinly app.")
        return api_error("internal", f"Twinly error {s} {code}".strip(), "See the server log.")

    async def _post_speak(self, text: str) -> httpx.Response:
        n429 = starting = 0
        retried503 = False
        while True:
            self._spend_check()
            await self.limiter.acquire()
            try:
                r = await self.http.post(f"{self.base}/voice/speak", params={"wait": 25}, json={"text": text})
            except httpx.HTTPError as e:  # not retried: the job may already exist
                raise api_error("twinly_offline", f"Could not reach Twinly ({type(e).__name__}).",
                                "Check wifi and that the Twinly Mac app is awake.")
            if r.status_code in (200, 202):
                self._spend_add()
                return r
            code = _error_code(r)
            if r.status_code == 429 or code == "rate_limited":
                if n429 >= 2:
                    raise api_error("rate_limited", "Twinly rate limit hit.", "Wait a minute and try again.")
                try:
                    wait = float(r.headers.get("retry-after", 3))
                except ValueError:
                    wait = 3.0
                n429 += 1
                await self.sleep(wait)
                continue
            if code == "voice_starting":
                if starting >= 3:
                    raise api_error("internal", "Twinly voice is still starting.", "Wait a few seconds and retry.")
                starting += 1
                await self.sleep(5)
                continue
            if r.status_code == 503 and code != "job_unverified" and not retried503:
                retried503 = True
                await self.sleep(1)
                continue
            raise self._raise_for(r, code)

    async def _await_job(self, first: httpx.Response) -> dict:
        body = _json(first)
        deadline = self.clock() + JOB_TIMEOUT_S
        resp, data = first, body
        while True:
            if _find(data, "audio_b64"):
                return data
            status = str(_find(data, "status") or "").lower()
            if status in _TERMINAL_FAIL:
                code = str(_find(data, "code") or "")
                if code == "voice_starting":  # arrives inside a 200 job body, not as an HTTP error
                    raise _VoiceStarting()
                raise self._raise_for(resp, code or "voice_failed")
            if status == "needs_approval":
                raise api_error("internal", "Twinly is waiting for approval on the Mac.",
                                "Approve the job in the Twinly app, or enable 'Let keys run tasks as you'.")
            job_id = _find(data, "id") or _find(data, "job_id")
            if not job_id:
                raise api_error("internal", "Twinly returned no job id.", "See fixtures/real_twinly_speak.json.")
            if self.clock() > deadline:
                raise api_error("twinly_offline", "Twinly took too long.", "Check the Twinly app is awake.")
            try:
                resp = await self.http.get(f"{self.base}/jobs/{job_id}", params={"wait": 25})
            except httpx.HTTPError as e:
                raise api_error("twinly_offline", f"Lost contact with Twinly ({type(e).__name__}).",
                                "Check wifi and the Twinly Mac app.")
            if resp.status_code >= 400:
                raise self._raise_for(resp, _error_code(resp))
            data = _json(resp)

    async def render(self, text: str) -> AudioChunk:
        """One chunk -> audio file (cache first)."""
        h = self.chunk_hash(text)
        hit = self._cached(h)
        if hit:
            return hit
        async with self.sem:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
            try:
                started = self.clock()
                for attempt in range(4):  # docs/md/04: voice_starting -> wait 5 s, retry up to 3x
                    t_try = self.clock()
                    first = await self._post_speak(text)
                    try:
                        data = await self._await_job(first)
                        break
                    except _VoiceStarting:
                        # A real voice_starting job fails after ~43 s (fixtures/real_twinly_voice_starting.json):
                        # only re-post if another attempt that long still fits in the budget.
                        took = self.clock() - t_try
                        if attempt == 3 or (self.clock() - started) + 5 + took > RENDER_BUDGET_S:
                            raise api_error("internal", "Twinly voice is still starting.",
                                            "Quit and reopen the Twinly app so its voice engine starts, then retry.")
                        await self.sleep(5)
            finally:
                self.in_flight -= 1
        b64 = _find(data, "audio_b64")
        try:
            audio = base64.b64decode(b64, validate=False)
        except (binascii.Error, TypeError):
            audio = b""
        if not audio:
            raise api_error("internal", "Twinly returned empty audio.", "Retry once.")
        seconds = _find(data, "seconds")
        try:
            seconds = float(seconds)
        except (TypeError, ValueError):
            seconds = round(max(1.0, len(text) / 15.0), 1)
        return self._store(h, audio, seconds)

    async def speak(self, text: str) -> SpeakResponse:
        t0 = time.perf_counter()
        text = (text or "").strip()
        if not text:
            raise api_error("bad_request", "Nothing to speak.", "Approve some text first.")
        if len(text) > MAX_TOTAL_CHARS:
            raise api_error("too_long", f"Text is {len(text)} characters (max {MAX_TOTAL_CHARS}).",
                            "Shorten the announcement.")
        chunks = split.pack(text, CHUNK_CHARS)
        results = await asyncio.gather(*(self.render(c) for c in chunks))  # gather keeps order
        return SpeakResponse(chunks=list(results), total_seconds=round(sum(c.seconds for c in results), 2),
                             ms=int((time.perf_counter() - t0) * 1000), synthetic=True)

    async def health(self) -> TwinlyHealth:
        if self._health and self.clock() - self._health[0] < HEALTH_TTL_S:
            return self._health[1]
        try:
            r = await self.http.get(f"{self.base}/me", timeout=6.0)
            j = _json(r)
            online = r.status_code == 200
            ready = online and _voice_ready(j)
            res = TwinlyHealth(online=online, voice_ready=ready)
        except httpx.HTTPError:
            res = TwinlyHealth(online=False, voice_ready=False)
        self._health = (self.clock(), res)
        return res


def _voice_ready(me: Any) -> bool:
    """Best-effort reading of GET /v1/me (shape confirmed at gate G1, see fixtures/real_twinly_me.json)."""
    setup = _find(me, "setup")
    if isinstance(setup, dict) and "voice" in setup:  # GET /v1/me: true when ready, else a how-to string
        return setup["voice"] is True
    for key in ("voice_ready", "voice_clone_ready", "has_voice", "voice_set_up"):
        v = _find(me, key)
        if isinstance(v, bool):
            return v
    v = _find(me, "voice")
    if isinstance(v, dict):
        st = str(v.get("status") or v.get("state") or "").lower()
        if st:
            return st in ("ready", "ok", "active", "built", "done")
        return True
    if isinstance(v, bool):
        return v
    return True  # unknown shape: don't block the UI; speak() reports voice_not_set_up if wrong


# ---- module-level API used by main.py ------------------------------------
_client: TwinlyClient | None = None


def _get_client() -> TwinlyClient:
    global _client
    if _client is None:
        _client = TwinlyClient(settings.TWINLY_API_KEY, settings.TWINLY_BASE, settings.cache_dir,
                               spend_path=settings.logs_dir / "spend.json",
                               allow_spend=os.environ.get("ALLOW_SPEND") == "1")
    return _client


def _mock_speak(text: str) -> SpeakResponse:
    """MOCK=1: copy the placeholder tone into the cache under the real hash so the file route works."""
    t0 = time.perf_counter()
    src = settings.fixtures_dir / "backup_demo.m4a"
    out = []
    for c in split.pack(text, CHUNK_CHARS):
        h = hashlib.sha256(f"{c}\x00mock".encode()).hexdigest()
        settings.cache_dir.mkdir(parents=True, exist_ok=True)
        dst = settings.cache_dir / f"{h}.m4a"
        if src.exists() and not dst.exists():
            shutil.copyfile(src, dst)
        out.append(AudioChunk(url=f"/api/audio/{h}.m4a", seconds=3.0, cached=False))
    return SpeakResponse(chunks=out, total_seconds=3.0 * len(out), ms=int((time.perf_counter() - t0) * 1000))


async def speak(text: str) -> SpeakResponse:
    if settings.MOCK:
        return _mock_speak(text)
    return await _get_client().speak(text)


async def health() -> TwinlyHealth:
    if settings.MOCK:
        return TwinlyHealth(online=True, voice_ready=True)
    return await _get_client().health()


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print('usage: python -m backend.voice "text to speak"   (MOCK=1 skips the network; real call costs ~$0.10/line)')
        return 2

    async def run():
        res = await speak(" ".join(args))
        print(json.dumps(res.model_dump(), indent=2))
        print("mock" if settings.MOCK else "real", f"- {res.ms} ms; files in {settings.cache_dir}")

    try:
        asyncio.run(run())
    except Exception as e:  # ApiError carries a code and hint
        print(f"{getattr(e, 'code', type(e).__name__)}: {e} {getattr(e, 'hint', '')}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
