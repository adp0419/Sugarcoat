from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    TWINLY_API_KEY: str = ""
    TWINLY_BASE: str = "https://advktwnedlgnhswpxokg.supabase.co/functions/v1/twinly-api/v1"
    OPENAI_API_KEY: str = ""
    DECISIONS_MODEL: str = "gpt-6-luna"
    GEMINI_API_KEY: str = ""
    GEMMA_MODEL: str = "gemma-4-26b-a4b-it"
    GEMMA_TIMEOUT_S: float = 12.0  # per Gemma call; Gemma 4 can hang for 60 s+ on the Gemini API
    GEMMA_BUDGET_S: float = 20.0  # all Gemma attempts for one rewrite, retries included (docs/md/02)
    JOB_DEADLINE_S: float = 90.0  # watchdog: a job always reaches ready/failed within this
    ASR_SIZE: str = "turbo"
    MOCK: bool = False
    DECISIONS_ENABLED: bool = True
    KEEP_AUDIO: bool = False
    DEV: bool = False
    # accounts groundwork (docs/md/10 "Accounts"); off = single global TWINLY_API_KEY, exactly as before
    AUTH_ENABLED: bool = False
    SUPABASE_URL: str = ""
    SUPABASE_JWT_SECRET: str = ""
    SUPABASE_SERVICE_KEY: str = ""
    ENCRYPTION_KEY: str = ""  # 32 random bytes, base64: encrypts each user's saved Twinly key (AES-256-GCM)
    PROFILE_STORE: str = "sqlite"  # sqlite (cache/profiles.sqlite) | supabase
    HOST: str = "127.0.0.1"
    PORT: int = 8000

    # derived paths (not env-driven)
    @property
    def cache_dir(self) -> Path:
        return ROOT / "cache"

    @property
    def logs_dir(self) -> Path:
        return ROOT / "logs"

    @property
    def fixtures_dir(self) -> Path:
        return ROOT / "fixtures"

    @property
    def frontend_dir(self) -> Path:
        return ROOT / "frontend"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
