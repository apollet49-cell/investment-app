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

    # Comma-separated list of allowed origins for CORS. Set on Render to
    # your deployed origin so credentials work correctly — wildcard "*"
    # with credentials is invalid per the CORS spec and browsers ignore it.
    # Empty falls back to the localhost dev pair (set in main.py).
    CORS_ALLOWED_ORIGINS: str = "http://localhost:8000,http://127.0.0.1:8000"

    # PostHog product analytics — leave empty in dev. Set on Render to
    # capture page views + feature usage. Free tier ~1M events/month.
    POSTHOG_API_KEY: str = ""
    POSTHOG_HOST: str = "https://eu.i.posthog.com"

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

    @field_validator("JWT_SECRET")
    @classmethod
    def jwt_secret_strong(cls, v: str) -> str:
        # HS256 with a short secret is offline-brute-forceable in seconds.
        # 32 chars is the practical minimum for a base64-ish secret.
        if len(v.strip()) < 32:
            raise ValueError(
                "JWT_SECRET must be at least 32 characters. Generate one with: "
                "python -c \"import secrets; print(secrets.token_urlsafe(48))\""
            )
        return v

    @field_validator("APP_ENCRYPTION_KEY")
    @classmethod
    def fernet_key_shape(cls, v: str) -> str:
        # Fernet expects exactly 32 url-safe base64-encoded bytes. Catching
        # this at boot beats discovering it on the first decrypt call.
        import base64
        try:
            decoded = base64.urlsafe_b64decode(v.strip())
        except Exception:
            raise ValueError(
                "APP_ENCRYPTION_KEY must be valid url-safe base64. Generate one with: "
                "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            )
        if len(decoded) != 32:
            raise ValueError("APP_ENCRYPTION_KEY must decode to exactly 32 bytes (Fernet requirement)")
        return v


settings = Settings()
