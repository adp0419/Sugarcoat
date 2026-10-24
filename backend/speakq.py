"""Async speak for stage mode: one global FIFO render queue (docs/md/10 "POST /api/speak/async").

Twinly's engine crashes with two concurrent jobs, so renders run one at a time in submission order; a second
segment waits behind the first instead of failing. Each chunk is published as soon as it is ready, in order,
so the UI can start playing chunk 1 while chunk 2 renders. Fully cached requests skip the queue. Requests are
kept in memory for TTL_S after they finish.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol

from . import split
from .errors import ApiError
from .models import AudioChunk, ErrorBody, SpeakStatus

log = logging.getLogger("voiceflow.speakq")

TTL_S = 3600.0
CHUNK_CHARS = 550  # same packer limit as voice.py


class Renderer(Protocol):
    """What the queue needs from a voice: voice.TwinlyClient satisfies it (render + chunk_hash + _cached)."""

    async def render(self, text: str) -> AudioChunk: ...
    def cached(self, text: str) -> AudioChunk | None: ...


@dataclass
class SpeakTask:
    id: str
    job_id: str
    texts: list[str]
    renderer: Renderer
    status: str = "queued"  # queued | rendering | done | failed
    chunks: list[AudioChunk] = field(default_factory=list)
    error: ErrorBody | None = None
    t0: float = field(default_factory=time.perf_counter)
    created: float = 0.0
    finished: float | None = None
    ms: int = 0


class SpeakQueue:
    def __init__(self, clock: Callable[[], float] = time.monotonic, ttl_s: float = TTL_S):
        self.clock = clock
        self.ttl_s = ttl_s
        self.tasks: dict[str, SpeakTask] = {}
        self.waiting: list[SpeakTask] = []  # FIFO; waiting[0] is next
        self.current: SpeakTask | None = None
        self._wake: asyncio.Event | None = None
        self._worker: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ---- public --------------------------------------------------------
    def submit(self, job_id: str, text: str, renderer: Renderer) -> SpeakTask:
        self.cleanup()
        texts = split.pack(text, CHUNK_CHARS)
        identity = getattr(renderer, "identity", id(renderer))
        for existing in self.tasks.values():
            if existing.status != "failed" and existing.job_id == job_id and existing.texts == texts and getattr(existing.renderer, "identity", id(existing.renderer)) == identity:
                return existing
        task = SpeakTask(id=uuid.uuid4().hex, job_id=job_id, texts=texts, renderer=renderer, created=self.clock())
        self.tasks[task.id] = task
        self._take_cached_prefix(task)
        if len(task.chunks) == len(texts):  # all cached: skip the queue
            self._finish(task, "done")
            return task
        self.waiting.append(task)
        self._ensure_worker()
        self._wake.set()
        return task

    def get(self, speak_id: str) -> SpeakTask | None:
        self.cleanup()
        return self.tasks.get(speak_id)

    def position(self, task: SpeakTask) -> int:
        """Renders ahead of this one: 0 when rendering or finished, 1 when one other render goes first, ..."""
        if task.status != "queued":
            return 0
        ahead = 1 if self.current is not None else 0
        return ahead + self.waiting.index(task) if task in self.waiting else 0

    def status(self, task: SpeakTask) -> SpeakStatus:
        return SpeakStatus(speak_id=task.id, job_id=task.job_id, status=task.status, chunks=list(task.chunks),
                           total_chunks=len(task.texts), queue_position=self.position(task), error=task.error,
                           ms=task.ms if task.finished is not None else int((time.perf_counter() - task.t0) * 1000))

    def cleanup(self) -> int:
        """Drop finished requests older than the TTL. Returns how many were removed."""
        now = self.clock()
        old = [k for k, t in self.tasks.items() if t.finished is not None and now - t.finished > self.ttl_s]
        for k in old:
            del self.tasks[k]
        return len(old)

    # ---- internals -----------------------------------------------------
    def _take_cached_prefix(self, task: SpeakTask) -> None:
        while len(task.chunks) < len(task.texts):
            hit = task.renderer.cached(task.texts[len(task.chunks)])
            if hit is None:
                return
            task.chunks.append(hit)

    def _finish(self, task: SpeakTask, status: str, error: ErrorBody | None = None) -> None:
        task.status, task.error = status, error
        task.finished = self.clock()
        task.ms = int((time.perf_counter() - task.t0) * 1000)

    def _ensure_worker(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is not loop:  # new event loop (server restart in tests): start fresh
            self._loop, self._wake, self._worker = loop, asyncio.Event(), None
        if self._worker is None or self._worker.done():
            self._worker = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            if not self.waiting:
                self._wake.clear()
                await self._wake.wait()
                continue
            task = self.waiting.pop(0)
            self.current = task
            task.status = "rendering"
            try:
                await self._render_all(task)
            finally:
                self.current = None

    async def _render_all(self, task: SpeakTask) -> None:
        try:
            for text in task.texts[len(task.chunks):]:
                task.chunks.append(await task.renderer.render(text))  # published as soon as it lands
            self._finish(task, "done")
        except ApiError as e:
            self._finish(task, "failed", ErrorBody(code=e.code, message=e.message, hint=e.hint))
        except Exception as e:  # noqa: BLE001 - a broken render must not kill the queue
            log.warning("speak %s failed: %s", task.id, type(e).__name__)
            self._finish(task, "failed", ErrorBody(code="internal", message=f"{type(e).__name__}",
                                                   hint="See the server log."))


class TwinlyRenderer:
    """Adapter over voice.TwinlyClient (T2's module, not modified): render + cache lookup by chunk hash."""

    def __init__(self, client):
        self.client = client
        self.identity = (client.base, client.voice_id)

    async def render(self, text: str) -> AudioChunk:
        return await self.client.render(text)

    def cached(self, text: str) -> AudioChunk | None:
        return self.client._cached(self.client.chunk_hash(text))


class MockRenderer:
    """MOCK=1: every chunk is the backup clip (owner's cloned voice) after a 0.6-1.2 s nap."""

    def __init__(self, nap: Callable[[], Awaitable[None]], url: str, seconds: float):
        self.nap, self.url, self.seconds = nap, url, seconds
        self.identity = "mock"

    async def render(self, text: str) -> AudioChunk:
        await self.nap()
        return AudioChunk(url=self.url, seconds=self.seconds, cached=False)

    def cached(self, text: str) -> AudioChunk | None:
        return None


QUEUE = SpeakQueue()
