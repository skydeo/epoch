"""DB → engine bridge.

The pure engine (``engine.py``) knows nothing about SQLModel or the database.
This module is the seam between them: it reads the ``AppSetting`` /
``AccrualTier`` / ``UsageEntry`` rows and hands the engine the immutable value
types it wants (``EngineConfig`` / ``UsageItem``). It also owns ``expand_range``,
the working-day expansion used when a usage range is entered.
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlmodel import Session, select

from epoch.engine import EngineConfig, Tier, UsageItem
from epoch.models import AccrualTier, AppSetting, UsageEntry, UsageType


def load_engine_config(session: Session) -> EngineConfig:
    """Build an ``EngineConfig`` from the ``AppSetting`` + ``AccrualTier`` rows.

    Mirrors the parse the ``cfg`` test fixture performs against the seeded
    defaults — the DB is the single source of truth for these constants so the
    user can edit them at runtime.
    """
    s = {row.key: row.value for row in session.exec(select(AppSetting)).all()}
    tier_rows = session.exec(
        select(AccrualTier).order_by(AccrualTier.starts_on)
    ).all()
    tiers = tuple(
        Tier(starts_on=t.starts_on, annual_hours=t.annual_hours) for t in tier_rows
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


def load_usage(session: Session) -> list[UsageItem]:
    """Read every ``UsageEntry`` as an engine ``UsageItem``.

    ``type == personal_holiday`` maps to ``is_ph=True`` so the engine routes it
    to the parallel personal-holiday bucket.
    """
    entries = session.exec(select(UsageEntry)).all()
    return [
        UsageItem(
            date=entry.date,
            hours=entry.hours,
            is_ph=entry.type == UsageType.personal_holiday,
        )
        for entry in entries
    ]


def expand_range(start: date, end: date, holidays: set[date]) -> list[date]:
    """Working days in ``[start, end]`` — skipping weekends and company holidays.

    Used when a usage range is entered: it becomes one per-day row per returned
    date. Returns an empty list if the range covers only weekends/holidays (the
    caller turns that into a 400).
    """
    days: list[date] = []
    current = start
    while current <= end:
        if current.weekday() < 5 and current not in holidays:
            days.append(current)
        current += timedelta(days=1)
    return days
