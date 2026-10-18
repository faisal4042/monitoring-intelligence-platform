"""Env is loaded from the repo-root .env — same file apps/api reads (docs/PROJECT_PLAN.md §96-100:
this service is stateless, has no DB connection, and knows nothing about X)."""
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_CANDIDATES = [
    Path.cwd() / ".env",
    *(parent / ".env" for parent in Path(__file__).resolve().parents),
]
ROOT_ENV = next((candidate for candidate in _ENV_CANDIDATES if candidate.is_file()), Path.cwd() / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(ROOT_ENV), extra="ignore")

    ai_port: int = 8000
    # Shared secret apps/api sends as a bearer token. Empty = no check (dev only).
    ai_api_key: str = ""

    embedding_provider: str = "siliconflow"
    embedding_dimensions: int = 1024

    siliconflow_api_key: str = ""
    siliconflow_base_url: str = "https://api.siliconflow.com/v1"
    siliconflow_embedding_model: str = "Qwen/Qwen3-Embedding-8B"

    label_provider: str = "deepseek"
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-v4-flash"


settings = Settings()
