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
    ASR_SIZE: str = "turbo"
    MOCK: bool = False
    DECISIONS_ENABLED: bool = True
    KEEP_AUDIO: bool = False
    DEV: bool = False
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
