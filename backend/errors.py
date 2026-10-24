from .models import ErrorBody, ErrorResponse

STATUS = {
    "no_speech": 422, "asr_failed": 500, "twinly_offline": 409, "voice_not_set_up": 409,
    "rate_limited": 429, "job_unverified": 503, "too_long": 413, "internal": 500,
    "not_found": 404, "bad_request": 400, "busy": 429, "unsupported_media": 415,
}


class ApiError(Exception):
    def __init__(self, code: str, message: str, hint: str = "", status: int | None = None):
        super().__init__(message)
        self.code, self.message, self.hint = code, message, hint
        self.status = status or STATUS.get(code, 500)

    def body(self) -> dict:
        return ErrorResponse(error=ErrorBody(code=self.code, message=self.message, hint=self.hint)).model_dump()


def api_error(code: str, message: str, hint: str = "", status: int | None = None) -> ApiError:
    return ApiError(code, message, hint, status)
