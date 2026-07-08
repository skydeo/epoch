"""Typed application configuration via pydantic-settings.

epoch keeps only *infrastructure* config here (the DB location). All the domain
constants that drive the accrual engine — hire date, period length, caps,
rollover, tiers — live in the database as ``AppSetting`` / ``AccrualTier`` rows
so the single user can edit them at runtime (see ``seed.py`` and
``domain.load_engine_config``). Overridable via env / ``.env`` for tests.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment / `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Database — overridable for tests ---
    db_path: Path = Path("/data/epoch.db")


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton (used as a FastAPI dependency).

    Tests clear the cache after overriding env vars.
    """
    return Settings()
