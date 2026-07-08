"""SQLModel data model.

Four tables back the whole app:

* ``UsageEntry``   — one PTO or personal-holiday day taken (the only real input).
* ``CompanyHoliday`` — paid company holidays, used to skip days when expanding a
  usage range and (later) for display.
* ``AccrualTier``  — the tenure tiers that set the annual accrual rate.
* ``AppSetting``   — a key/value bag of the engine's tunable constants.

Nothing derived (period rows, running balances) is ever persisted — the accrual
engine recomputes it on the fly (see ``engine.py``).
"""

from __future__ import annotations

import datetime as dt
from datetime import UTC
from enum import StrEnum

from sqlmodel import Field, SQLModel


def now_utc() -> dt.datetime:
    """Return the current UTC time as a *naive* datetime.

    SQLite (via SQLAlchemy) stores datetimes as strings and reads them back
    without tzinfo, so the whole app standardizes on naive-UTC to keep DB
    round-trips and time comparisons consistent.
    """
    return dt.datetime.now(UTC).replace(tzinfo=None)


class UsageType(StrEnum):
    """Which bucket a usage entry draws from."""

    pto = "pto"
    personal_holiday = "personal_holiday"


class UsageEntry(SQLModel, table=True):
    """A single day (or partial day) of PTO / personal-holiday taken."""

    id: int | None = Field(default=None, primary_key=True)
    date: dt.date = Field(index=True)
    hours: float = 8.0
    type: UsageType = Field(default=UsageType.pto)
    reason: str | None = None
    requested: bool = False  # entered into the HR system yet?
    created_at: dt.datetime = Field(default_factory=now_utc)
    updated_at: dt.datetime | None = None


class CompanyHoliday(SQLModel, table=True):
    """A paid company holiday — skipped when expanding a usage range."""

    id: int | None = Field(default=None, primary_key=True)
    date: dt.date = Field(unique=True)
    name: str


class AccrualTier(SQLModel, table=True):
    """A tenure tier: from ``starts_on`` onward, accrue ``annual_hours`` a year.

    ``annual_hours`` is authoritative; ``annual_days`` is display sugar.
    """

    id: int | None = Field(default=None, primary_key=True)
    starts_on: dt.date = Field(unique=True)  # 2023-01-09 / 2028-01-09 / 2033-01-09
    annual_days: float
    annual_hours: float
    label: str


class AppSetting(SQLModel, table=True):
    """A single tunable engine constant, stored as text and parsed by domain."""

    key: str = Field(primary_key=True)
    value: str
