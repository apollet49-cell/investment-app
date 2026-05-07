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

    ALPHA_VANTAGE_KEY: str
    OPEN_EXCHANGE_RATES_KEY: str
    FRED_KEY: str

    DATABASE_URL: str = "sqlite:///./app.db"

    @field_validator("APP_ENCRYPTION_KEY", "JWT_SECRET", "ALPHA_VANTAGE_KEY", "OPEN_EXCHANGE_RATES_KEY", "FRED_KEY")
    @classmethod
    def not_empty(cls, v: str, info) -> str:
        if not v or not v.strip():
            raise ValueError(f"{info.field_name} is required (see README for how to obtain)")
        return v


settings = Settings()
