"""Idempotent default seeding.

Run once on every startup (from the lifespan). Every insert is *insert-if-
missing*, keyed on the natural/primary key, so the user's later edits to
settings, tiers, and holidays survive restarts and a fresh row is only added
when it is genuinely absent. Nothing here ever overwrites an existing value.
"""

from __future__ import annotations

from datetime import date

from sqlmodel import Session, select

from epoch.models import AccrualTier, AppSetting, CompanyHoliday

# --- Engine constants (AppSetting) -----------------------------------------
# Parsed by domain.load_engine_config into an EngineConfig. Values are the
# spreadsheet-verified defaults; the user can edit them in Settings.
DEFAULT_SETTINGS: dict[str, str] = {
    "hire_date": "2023-01-09",
    "period_length_days": "14",
    "pay_date_offset_days": "5",
    "periods_per_year": "26",
    "hours_per_day": "8",
    "max_balance_hours": "360",
    "rollover_hours": "240",
    "ph_annual_hours": "16",
    "projection_horizon_months": "18",
    "round_period_accrual": "true",
}

# --- Tenure tiers (AccrualTier) --------------------------------------------
# annual_hours is authoritative; the +5-day bumps land on the 5- and 10-year
# service anniversaries. rate = round(annual_hours / 26, 2) => 6.77 / 8.31 / 9.85.
DEFAULT_TIERS: list[dict] = [
    {
        "starts_on": date(2023, 1, 9),
        "annual_days": 22.0,
        "annual_hours": 176.0,
        "label": "22 days/yr (hire)",
    },
    {
        "starts_on": date(2028, 1, 9),
        "annual_days": 27.0,
        "annual_hours": 216.0,
        "label": "27 days/yr (5 years)",
    },
    {
        "starts_on": date(2033, 1, 9),
        "annual_days": 32.0,
        "annual_hours": 256.0,
        "label": "32 days/yr (10 years)",
    },
]

# --- Starter company-holiday list ------------------------------------------
# Typical US corporate holidays for the current + next calendar year, with
# weekend holidays shifted to the observed weekday. The user edits these in
# Settings; they are only used to skip days when expanding a usage range.
DEFAULT_HOLIDAYS: list[dict] = [
    # 2026
    {"date": date(2026, 1, 1), "name": "New Year's Day"},
    {"date": date(2026, 1, 19), "name": "Martin Luther King Jr. Day"},
    {"date": date(2026, 2, 16), "name": "Presidents' Day"},
    {"date": date(2026, 5, 25), "name": "Memorial Day"},
    {"date": date(2026, 6, 19), "name": "Juneteenth"},
    {"date": date(2026, 7, 3), "name": "Independence Day (observed)"},
    {"date": date(2026, 9, 7), "name": "Labor Day"},
    {"date": date(2026, 11, 26), "name": "Thanksgiving Day"},
    {"date": date(2026, 11, 27), "name": "Day after Thanksgiving"},
    {"date": date(2026, 12, 25), "name": "Christmas Day"},
    # 2027
    {"date": date(2027, 1, 1), "name": "New Year's Day"},
    {"date": date(2027, 1, 18), "name": "Martin Luther King Jr. Day"},
    {"date": date(2027, 2, 15), "name": "Presidents' Day"},
    {"date": date(2027, 5, 31), "name": "Memorial Day"},
    {"date": date(2027, 6, 18), "name": "Juneteenth (observed)"},
    {"date": date(2027, 7, 5), "name": "Independence Day (observed)"},
    {"date": date(2027, 9, 6), "name": "Labor Day"},
    {"date": date(2027, 11, 25), "name": "Thanksgiving Day"},
    {"date": date(2027, 11, 26), "name": "Day after Thanksgiving"},
    {"date": date(2027, 12, 24), "name": "Christmas Day (observed)"},
]


def seed_defaults(session: Session) -> None:
    """Insert any missing default settings, tiers, and holidays. Idempotent."""
    _seed_settings(session)
    _seed_tiers(session)
    _seed_holidays(session)
    session.commit()


def _seed_settings(session: Session) -> None:
    existing = set(session.exec(select(AppSetting.key)).all())
    for key, value in DEFAULT_SETTINGS.items():
        if key not in existing:
            session.add(AppSetting(key=key, value=value))


def _seed_tiers(session: Session) -> None:
    existing = set(session.exec(select(AccrualTier.starts_on)).all())
    for tier in DEFAULT_TIERS:
        if tier["starts_on"] not in existing:
            session.add(AccrualTier(**tier))


def _seed_holidays(session: Session) -> None:
    existing = set(session.exec(select(CompanyHoliday.date)).all())
    for holiday in DEFAULT_HOLIDAYS:
        if holiday["date"] not in existing:
            session.add(CompanyHoliday(**holiday))
