"""Shared test fixtures.

Mirrors the sibling ``fetch`` project's style: every fixture that touches the
filesystem or DB is pinned to ``tmp_path`` so tests never read or write the real
DB. Adds a no-DB ``cfg`` fixture holding an ``EngineConfig`` built from the
seeded defaults, so the pure-engine tests need no database at all.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path

import pytest

from epoch.config import Settings
from epoch.db import init_db, reset_engine
from epoch.engine import EngineConfig, Tier
from epoch.seed import DEFAULT_SETTINGS, DEFAULT_TIERS


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Settings pinned to a throwaway DB under the test's tmp dir."""
    return Settings(db_path=tmp_path / "data" / "epoch.db")


@pytest.fixture
def db(settings: Settings) -> Iterator[None]:
    """Initialize the global DB engine against the test settings.

    Resets the engine afterwards so each test gets a fresh SQLite file.
    """
    init_db(settings)
    try:
        yield
    finally:
        reset_engine()


@pytest.fixture
def client(settings: Settings) -> Iterator["TestClient"]:  # noqa: F821
    """A TestClient over the full app (runs the lifespan: init_db + seed)."""
    from fastapi.testclient import TestClient

    from epoch.main import create_app

    app = create_app(settings)
    with TestClient(app) as test_client:
        yield test_client
    reset_engine()


@pytest.fixture
def cfg() -> EngineConfig:
    """A no-DB ``EngineConfig`` built from the seeded defaults.

    Kept in lock-step with ``seed.DEFAULT_SETTINGS`` / ``DEFAULT_TIERS`` so the
    engine tests exercise exactly the constants the app ships with.
    """
    s = DEFAULT_SETTINGS
    tiers = tuple(
        Tier(starts_on=t["starts_on"], annual_hours=t["annual_hours"])
        for t in DEFAULT_TIERS
    )
    return EngineConfig(
        hire_date=date.fromisoformat(s["hire_date"]),
        period_length_days=int(s["period_length_days"]),
        pay_date_offset_days=int(s["pay_date_offset_days"]),
        periods_per_year=int(s["periods_per_year"]),
        hours_per_day=float(s["hours_per_day"]),
        max_balance_hours=float(s["max_balance_hours"]),
        rollover_hours=float(s["rollover_hours"]),
        ph_annual_hours=float(s["ph_annual_hours"]),
        projection_horizon_months=int(s["projection_horizon_months"]),
        round_period_accrual=s["round_period_accrual"].lower() == "true",
        tiers=tiers,
    )
