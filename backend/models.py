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
    "job_unverified", "too_long", "internal", "not_found", "bad_request", "busy", "unsupported_media", "unauthorized",
)
# /api/health provider states. no_credits / auth_error come from the most recent real call (never a paid probe).
ProviderStatus = Literal["ok", "off", "error", "no_credits", "auth_error"]


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
    fast: bool = False  # stage-mode fast path: no Decisions, no retry, Gemma <= 4 s, rules-only guard
    use_decisions: bool = True  # False = switched off in Settings: no decide call, rules-only guard
    session: Optional[str] = None  # stage mode: echoes POST /api/process `session` / `segment`
    segment: Optional[int] = None
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


class MeVoiceRequest(_Base):
    """PUT /api/me/voice (AUTH_ENABLED=1). The key is write-only: no response ever contains it."""
    twinly_key: str = Field(min_length=10, max_length=300)
    label: str = Field("", max_length=80)


class MeVoice(_Base):
    has_key: bool
    label: str = ""
    online: bool = False
    voice_ready: bool = False


class SpeakAccepted(_Base):
    speak_id: str
    queue_position: int = 0
    status: Literal["queued", "rendering", "done", "failed"] = "queued"


class SpeakStatus(_Base):
    """GET /api/speak/{speak_id}. `chunks` grows in order as each chunk is rendered; on `failed` the chunks
    already listed are still playable."""
    speak_id: str
    job_id: str
    status: Literal["queued", "rendering", "done", "failed"]
    chunks: list[AudioChunk] = []
    total_chunks: int = 0
    queue_position: int = 0  # renders ahead of this one (0 = rendering now or finished)
    error: Optional[ErrorBody] = None
    ms: int = 0
    render_started_ms: Optional[int] = None  # ms after submit that Twinly started this request (0 = all cached)
    first_chunk_ms: Optional[int] = None  # ms after submit that chunk 1 became playable
    synthetic: bool = True


class StageTimings(_Base):
    convert_ms: int = 0
    asr_ms: int = 0
    rewrite_ms: int = 0
    guard_ms: int = 0
    total_ms: int = 0


class StageSegmentResponse(_Base):
    """POST /api/stage/segment: one sentence in, text + guard + (if approved and passing) a queued render out."""
    job_id: str
    session: str
    segment: int
    verbatim: str
    rewrite: str
    guard: GuardResult
    speak_id: Optional[str] = None  # poll GET /api/speak/{speak_id}
    held: bool = False  # guard failed: nothing queued until the user approves (POST /api/speak/async)
    timings: StageTimings = StageTimings()


class ProcessAccepted(_Base):
    job_id: str
    session: Optional[str] = None
    segment: Optional[int] = None


class SessionJob(_Base):
    job_id: str
    segment: Optional[int] = None
    status: JobStatus
    rung: Rung
    rewrite: str = ""
    guard_pass: Optional[bool] = None  # None while running / guard unavailable
    total_ms: int = 0


class SessionResponse(_Base):
    """GET /api/session/{id}: the session's jobs in segment order (stage mode)."""
    session: str
    jobs: list[SessionJob] = []


class LiveResponse(_Base):
    """POST /api/live: rough draft of the recording so far. Not the verbatim of record."""
    seq: int
    text: str
    ms: int
    final: bool = False


# ---- Health ----
class TwinlyHealth(_Base):
    online: bool = False
    voice_ready: bool = False


class HealthResponse(_Base):
    asr_loaded: bool
    decisions: ProviderStatus
    gemma: Literal["ok", "error", "no_credits", "auth_error"]
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
SpeakStatus.model_rebuild()
