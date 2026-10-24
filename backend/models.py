"""Shared contract (docs/md/10-api-contract.md). Mirror changes in frontend types + the doc in the same commit.

JSON aliases: Edit.from_ <-> "from", GuardResult.pass_ <-> "pass". Always dump with by_alias=True.
"""
from __future__ import annotations

import warnings
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# contract field is literally "register"; it shadows a harmless pydantic attribute
warnings.filterwarnings("ignore", message='Field name "register"')

Mode = Literal["minimal", "natural", "presenter"]
ModeChoice = Literal["auto", "minimal", "natural", "presenter"]
Rung = Literal["full", "retry", "minimal", "original"]
JobStatus = Literal["running", "ready", "failed"]
EditReason = Literal["filler", "repetition", "self_correction", "false_start", "grammar", "restructure"]
StageName = Literal["convert", "asr", "decide", "rewrite", "guard", "speak"]
ERROR_CODES = (
    "no_speech", "asr_failed", "twinly_offline", "voice_not_set_up", "rate_limited",
    "job_unverified", "too_long", "internal", "not_found", "bad_request",
)


class _Base(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


# ---- ASR ----
class Word(_Base):
    w: str
    start: float
    end: float


class ASRResult(_Base):
    text: str
    words: list[Word] = []
    seconds: float = 0.0


# ---- Rewrite ----
class Edit(_Base):
    from_: str = Field(alias="from")
    to: str
    reason: EditReason


class RewriteResult(_Base):
    rewrite: str
    edits: list[Edit] = []


# ---- Decisions (T2: decide.analyze) ----
class SentenceDecision(_Base):
    index: int
    text: str
    keep: bool = False  # True = "leave unchanged"
    issues: list[str] = []
    needs_edit_prob: Optional[float] = None


class Decisions(_Base):
    available: bool = True  # False when DECISIONS_ENABLED=0 / API down (never fake output)
    predicates: dict[str, float] = {}
    register: str = "casual"
    recommended_mode: Mode = "natural"
    per_sentence: list[SentenceDecision] = []
    note: Optional[str] = None


# ---- Guard (T2: guard.check) ----
class Violation(_Base):
    rule: str
    original_span: str = ""
    rewrite_span: str = ""
    message: str  # plain English, shown in UI


class GuardResult(_Base):
    pass_: bool = Field(alias="pass")
    violations: list[Violation] = []
    decisions_probs: dict[str, float] = {}
    verifier: Literal["online", "offline"] = "offline"


# ---- Trace / stage ----
class TraceEntry(_Base):
    stage: str
    ok: bool
    ms: int
    model: Optional[str] = None
    preview: str = ""
    error: Optional[str] = None


class StageResult(_Base):
    ok: bool
    data: Any = None
    ms: int = 0
    error: Optional[str] = None


class Timings(_Base):
    total_ms: int = 0


# ---- Job ----
class Job(_Base):
    id: str
    status: JobStatus = "running"
    mode_requested: ModeChoice = "auto"
    mode_used: Optional[Mode] = None
    rung: Rung = "full"
    verbatim: str = ""
    words: list[Word] = []
    sentences: list[str] = []
    decisions: Optional[Decisions] = None
    rewrite: str = ""
    edits: list[Edit] = []
    guard: Optional[GuardResult] = None
    trace: list[TraceEntry] = []
    timings: Timings = Timings()
    protected_terms: list[str] = []
    notes: list[str] = []  # UI banners, e.g. "AI verifier offline", "no changes made"
    error: Optional[ErrorBody] = None


# ---- Speak (T2: voice.speak) ----
class AudioChunk(_Base):
    url: str
    seconds: float
    cached: bool = False


class SpeakResponse(_Base):
    chunks: list[AudioChunk]
    total_seconds: float
    ms: int = 0
    synthetic: bool = True  # UI must label audio "synthetic"


# ---- Requests ----
class RewriteRequest(_Base):
    job_id: str
    mode: Optional[Mode] = None
    edited_text: Optional[str] = None


class SpeakRequest(_Base):
    job_id: str
    text: str


class ProcessAccepted(_Base):
    job_id: str


# ---- Health ----
class TwinlyHealth(_Base):
    online: bool = False
    voice_ready: bool = False


class HealthResponse(_Base):
    asr_loaded: bool
    decisions: Literal["ok", "off", "error"]
    gemma: Literal["ok", "error"]
    twinly: TwinlyHealth
    mock: bool


# ---- Errors ----
class ErrorBody(_Base):
    code: str
    message: str
    hint: str = ""


class ErrorResponse(_Base):
    error: ErrorBody


Job.model_rebuild()
