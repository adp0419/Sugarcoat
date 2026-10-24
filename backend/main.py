"""FastAPI app: skeleton with every contract endpoint stubbed (docs/md/10). Orchestrator lands in checkpoint 4."""
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .errors import ApiError, api_error
from .models import (
    HealthResponse, Job, ProcessAccepted, RewriteRequest, SpeakRequest, SpeakResponse, TwinlyHealth,
)

app = FastAPI(title="VoiceFlow")


@app.exception_handler(ApiError)
async def _api_error(_: Request, e: ApiError):
    return JSONResponse(e.body(), status_code=e.status)


def _todo(what: str) -> ApiError:
    return api_error("internal", f"{what} not implemented yet", "Backend skeleton only.", 501)


@app.get("/api/health", response_model=HealthResponse)
async def health():
    return HealthResponse(
        asr_loaded=False,
        decisions="ok" if settings.MOCK else ("off" if not settings.DECISIONS_ENABLED else "error"),
        gemma="ok" if settings.MOCK else "error",
        twinly=TwinlyHealth(online=settings.MOCK, voice_ready=settings.MOCK),
        mock=settings.MOCK,
    )


@app.post("/api/process", status_code=202, response_model=ProcessAccepted)
async def process(audio: UploadFile = File(...), mode: str = Form("auto"), protected_terms: str = Form("")):
    raise _todo("process")


@app.get("/api/jobs/{job_id}", response_model=Job, response_model_by_alias=True)
async def get_job(job_id: str):
    raise _todo("get_job")


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    raise _todo("job_events")


@app.post("/api/rewrite", response_model=Job, response_model_by_alias=True)
async def rewrite(req: RewriteRequest):
    raise _todo("rewrite")


@app.post("/api/speak", response_model=SpeakResponse)
async def speak(req: SpeakRequest):
    raise _todo("speak")


@app.get("/api/audio/{name}")
async def audio(name: str):
    raise _todo("audio")


frontend_dir = settings.frontend_dir
frontend_dir.mkdir(exist_ok=True)
app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
