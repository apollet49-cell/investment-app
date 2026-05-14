from __future__ import annotations

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=True)

    APP_ENCRYPTION_KEY: str
    JWT_SECRET: str
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_DAYS: int = 7

    ANTHROPIC_API_KEY: str = ""
    # Default Claude model. Override via env to upgrade without code changes.
    ANTHROPIC_MODEL: str = "claude-sonnet-4-20250514"

    ALPHA_VANTAGE_KEY: str
    OPEN_EXCHANGE_RATES_KEY: str
    FRED_KEY: str

    DATABASE_URL: str = "sqlite:///./app.db"

    # Comma-separated list of allowed origins for CORS. Empty defaults to a
    # local-dev whitelist (the app served by FastAPI itself). For prod, set
    # to your deployed origin so credentials work correctly — wildcard "*"
    # with credentials is invalid per the CORS spec and browsers ignore it.
    CORS_ALLOWED_ORIGINS: str = "http://localhost:8000,http://127.0.0.1:8000,https://investment-app-kud9.onrender.com"

    # Sentry DSN — paste from sentry.io project settings. Leave empty to
    # disable error reporting (e.g. in local dev and CI).
    SENTRY_DSN: str = ""
    SENTRY_ENV: str = "production"
    # Sample rate for performance tracing (0.0 = off, 1.0 = every transaction).
    # Sentry's free tier allows ~10k events/month — keep it modest.
    SENTRY_TRACES_SAMPLE_RATE: float = 0.05

    @field_validator("APP_ENCRYPTION_KEY", "JWT_SECRET", "ALPHA_VANTAGE_KEY", "OPEN_EXCHANGE_RATES_KEY", "FRED_KEY")
    @classmethod
    def not_empty(cls, v: str, info) -> str:
        if not v or not v.strip():
            raise ValueError(f"{info.field_name} is required (see README for how to obtain)")
        return v


settings = Settings()
