"""Shared computation and persistence helpers behind the JSON API.

These functions were extracted from the legacy server-rendered route modules
(``pages.py`` / ``usage.py`` / ``settings_ui.py``) when the HTML/HTMX layer was
replaced by the SPA. They are thin orchestration over the pure engine and the
SQLModel tables; ``routes/api.py`` is the only serialization layer on top.

"Today" is read from the clock *only* here and passed into the engine as a
parameter — the engine itself stays clock-free.
"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import HTTPException, status
from sqlmodel import select

from epoch.domain import expand_range, load_engine_config
from epoch.engine import (
    EngineConfig,
    PeriodRow,
    accrual_rate,
    balance_on,
    compute_ledger,
    loss_warnings,
    period_bounds,
)
from epoch.models import AccrualTier, AppSetting, CompanyHoliday, UsageEntry, UsageType


def today() -> date:
    """The clock read — isolated so the engine stays deterministic."""
    return date.today()


def date_from_iso(value: str) -> date:
    """Parse an ISO date, raising ``ValueError`` on anything malformed."""
    return date.fromisoformat(value)


def horizon(cfg: EngineConfig, on: date) -> date:
    """``on`` + the configured projection horizon (whole-month, stdlib only).

    The day is clamped to 28 so month-end arithmetic never overflows.
    """
    total = on.year * 12 + (on.month - 1) + cfg.projection_horizon_months
    year, month = divmod(total, 12)
    return date(year, month + 1, min(on.day, 28))


def row_state(row: PeriodRow, on: date) -> str:
    """``past`` / ``current`` / ``future`` for a ledger row relative to ``on``."""
    if on < row.start:
        return "future"
    if on > row.end:
        return "past"
    return "current"


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


def dashboard_stats(cfg: EngineConfig, usage, on: date) -> dict:
    """Compute every stat card from a single ledger fold through ``on``."""
    ledger = compute_ledger(cfg, usage, on)
    snap = balance_on(cfg, usage, on)
    current = ledger[-1]

    max_balance = max((r.balance for r in ledger), default=0.0)
    pct_of_cap = (
        (current.balance / cfg.max_balance_hours * 100.0)
        if cfg.max_balance_hours
        else 0.0
    )
    pto_used_ytd = round(sum(r.pto_used for r in ledger if r.end.year == on.year), 2)

    # Next pay: earliest period (from the current one onward) whose pay date
    # has not yet passed.
    next_pay_date = None
    next_pay_accrual = 0.0
    idx = current.index
    for _ in range(3):  # current + a couple ahead is always enough
        start, end, pay = period_bounds(cfg, idx)
        if pay >= on:
            next_pay_date = pay
            next_pay_accrual = accrual_rate(cfg, end)
            break
        idx += 1

    return {
        "current_balance": current.balance,
        "current_balance_negative": current.balance < 0,
        "ph_remaining": snap.ph_remaining,
        "ph_granted": snap.ph_granted,
        "max_balance": round(max_balance, 2),
        "pct_of_cap": round(pct_of_cap, 1),
        "cap": cfg.max_balance_hours,
        "pto_used_ytd": pto_used_ytd,
        "next_pay_date": next_pay_date,
        "next_pay_accrual": next_pay_accrual,
        "year": on.year,
        "warnings": snap.warnings,
    }


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


def projection_snapshot(cfg: EngineConfig, usage, on: date, target: date) -> dict:
    """Balance snapshot + span warnings for a projection to ``target``.

    ``balance_on(target)`` gives the end-of-period balance of the period
    *containing* ``target``; span warnings scan the ledger rows overlapping the
    window between ``on`` (today) and the target for cap / rollover
    forfeitures.
    """
    snap = balance_on(cfg, usage, target)
    p_start, p_end, p_pay = period_bounds(cfg, snap.period)

    lo, hi = min(on, target), max(on, target)
    span_rows = [
        r for r in compute_ledger(cfg, usage, hi) if r.end >= lo and r.start <= hi
    ]
    warnings = list(snap.warnings) + loss_warnings(span_rows)

    return {
        "snap": snap,
        "period_start": p_start,
        "period_end": p_end,
        "period_pay": p_pay,
        "balance_negative": snap.pto_balance < 0,
        "warnings": warnings,
        "target": target,
        "today": on,
        "is_future": target > on,
    }


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #


def usage_type(value: str) -> UsageType:
    """Map a loosely-typed ``type`` value to a ``UsageType`` (default PTO)."""
    return (
        UsageType.personal_holiday
        if "personal" in (value or "").lower()
        else UsageType.pto
    )


def create_range_entries(
    session,
    start_date: date,
    end_date: date,
    kind: UsageType,
    reason: str | None,
    requested: bool,
) -> list[UsageEntry]:
    """Expand a range into per-day usage rows at ``hours_per_day`` each.

    Raises a 400 ``HTTPException`` if the range starts before the hire date or
    expands to zero working days (weekend/holiday-only).
    """
    cfg = load_engine_config(session)
    if start_date < cfg.hire_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"start date {start_date.isoformat()} precedes hire date "
                f"{cfg.hire_date.isoformat()}"
            ),
        )
    holidays = {h.date for h in session.exec(select(CompanyHoliday)).all()}
    days = expand_range(start_date, end_date, holidays)
    if not days:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="range contains no working days (weekends/holidays only)",
        )

    cleaned_reason = (reason or "").strip() or None
    created: list[UsageEntry] = []
    for day in days:
        entry = UsageEntry(
            date=day,
            hours=cfg.hours_per_day,
            type=kind,
            reason=cleaned_reason,
            requested=requested,
        )
        session.add(entry)
        created.append(entry)
    session.commit()
    for entry in created:
        session.refresh(entry)
    return created


def get_entry(session, entry_id: int) -> UsageEntry:
    """One usage entry by id, or a 404 ``HTTPException``."""
    entry = session.get(UsageEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"usage entry {entry_id} not found",
        )
    return entry


def usage_entry_json(entry: UsageEntry) -> dict:
    """The canonical UsageEntry JSON shape consumed by the SPA.

    Kept here (not in the route layer) so ``group_trips`` can serialize the
    per-day rows it nests inside each trip with exactly the same shape.
    """
    return {
        "id": entry.id,
        "date": entry.date.isoformat(),
        "hours": entry.hours,
        "type": entry.type.value,
        "reason": entry.reason,
        "requested": entry.requested,
    }


def get_entries(session, ids: list[int]) -> list[UsageEntry]:
    """Fetch every id, raising 404 if *any* is missing (bulk-op precondition)."""
    return [get_entry(session, entry_id) for entry_id in ids]


# --------------------------------------------------------------------------- #
# Usage: trip grouping
# --------------------------------------------------------------------------- #


def _next_working_day(d: date, holidays: set[date]) -> date:
    """The first working day strictly after ``d`` (skips weekends + holidays)."""
    nxt = d + timedelta(days=1)
    while nxt.weekday() >= 5 or nxt in holidays:
        nxt += timedelta(days=1)
    return nxt


def _trip_dict(entries: list[UsageEntry]) -> dict:
    """Serialize one run of contiguous same-key entries into a trip dict."""
    dates = [e.date for e in entries]
    flags = [e.requested for e in entries]
    if all(flags):
        requested = "all"
    elif not any(flags):
        requested = "none"
    else:
        requested = "some"
    return {
        "start": min(dates).isoformat(),
        "end": max(dates).isoformat(),
        "days": [usage_entry_json(e) for e in entries],
        "day_count": len(entries),
        "total_hours": round(sum(e.hours for e in entries), 2),
        "type": entries[0].type.value,
        "reason": (entries[0].reason or "").strip() or None,
        "requested": requested,
        "ids": [e.id for e in entries],
    }


def group_trips(rows: list[UsageEntry], holidays: set[date]) -> list[dict]:
    """Fold per-day usage rows into mentally-adjacent "trips".

    Rows are sorted by date ascending. Two consecutive entries belong to the
    same trip iff they share a ``type``, share a ``reason`` (compared after
    ``(reason or "").strip()`` so empty reasons group together), and the later
    entry falls on-or-before the **next working day** after the earlier one —
    i.e. only weekends and company holidays may sit between them. Any actual
    working-day gap, or a differing type/reason, starts a new trip. Multiple
    entries on the same date with the same key stay in one trip.
    """
    ordered = sorted(rows, key=lambda e: (e.date, e.id or 0))
    trips: list[dict] = []
    run: list[UsageEntry] = []
    for entry in ordered:
        if run:
            prev = run[-1]
            same_key = prev.type == entry.type and (prev.reason or "").strip() == (
                entry.reason or ""
            ).strip()
            contiguous = entry.date <= _next_working_day(prev.date, holidays)
            if not (same_key and contiguous):
                trips.append(_trip_dict(run))
                run = []
        run.append(entry)
    if run:
        trips.append(_trip_dict(run))
    return trips


# --------------------------------------------------------------------------- #
# Settings: engine constants
# --------------------------------------------------------------------------- #

# Each engine constant with its input kind, label, and help text. The kind
# drives both the SPA's rendered input type and the server-side validation.
#   (key, kind, label, help)
SETTINGS_FIELDS: list[tuple[str, str, str, str]] = [
    ("hire_date", "date", "Hire date", "Anchors every pay period (a Monday)."),
    ("period_length_days", "int", "Period length (days)", "14 for biweekly."),
    ("pay_date_offset_days", "int", "Pay-date offset (days)", "Days after period end that pay lands."),
    ("periods_per_year", "int", "Periods per year", "26 for biweekly; divides the annual rate."),
    ("hours_per_day", "float", "Hours per day", "Default hours for one usage day."),
    ("max_balance_hours", "float", "Max balance / cap (hours)", "Hard cap; accrual above it is forfeited."),
    ("rollover_hours", "float", "Year-end rollover cap (hours)", "Balance above this is forfeited at Jan 1."),
    ("ph_annual_hours", "float", "Personal-holiday hours / year", "Granted Jan 1, use-or-lose Dec 31."),
    ("projection_horizon_months", "int", "Projection horizon (months)", "How far the dashboard chart looks ahead."),
    ("round_period_accrual", "bool", "Round per-period accrual", "Round the rate to 2dp (matches the sheet)."),
]


def load_settings(session) -> dict[str, str]:
    return {row.key: row.value for row in session.exec(select(AppSetting)).all()}


def persist_settings(session, values: dict[str, str]) -> None:
    """Upsert every validated constant."""
    for key, value in values.items():
        row = session.get(AppSetting, key)
        if row is None:
            session.add(AppSetting(key=key, value=value))
        else:
            row.value = value
            session.add(row)
    session.commit()


def validate_settings(form) -> tuple[dict[str, str], list[str]]:
    """Validate every constant; return (values-to-save, error messages)."""
    values: dict[str, str] = {}
    errors: list[str] = []
    for key, kind, label, _help in SETTINGS_FIELDS:
        if kind == "bool":
            values[key] = "true" if form.get(key) else "false"
            continue
        raw = (form.get(key) or "").strip()
        if kind == "date":
            try:
                date.fromisoformat(raw)
                values[key] = raw
            except ValueError:
                errors.append(f"{label}: not a valid date (YYYY-MM-DD).")
        elif kind == "int":
            try:
                n = int(raw)
            except ValueError:
                errors.append(f"{label}: must be a whole number.")
            else:
                if n <= 0:
                    errors.append(f"{label}: must be greater than 0.")
                else:
                    values[key] = str(n)
        else:  # float
            try:
                x = float(raw)
            except ValueError:
                errors.append(f"{label}: must be a number.")
            else:
                if x <= 0:
                    errors.append(f"{label}: must be greater than 0.")
                else:
                    values[key] = raw
    return values, errors


# --------------------------------------------------------------------------- #
# Settings: company holidays
# --------------------------------------------------------------------------- #


def load_holidays(session) -> list[CompanyHoliday]:
    return list(
        session.exec(select(CompanyHoliday).order_by(CompanyHoliday.date)).all()
    )


def create_holiday(session, d: date, name: str) -> None:
    """Idempotent-on-date insert of a company holiday."""
    exists = session.exec(
        select(CompanyHoliday).where(CompanyHoliday.date == d)
    ).first()
    if exists is None:
        session.add(CompanyHoliday(date=d, name=name.strip() or d.isoformat()))
        session.commit()


def remove_holiday(session, holiday_id: int) -> None:
    holiday = session.get(CompanyHoliday, holiday_id)
    if holiday is not None:
        session.delete(holiday)
        session.commit()


# --------------------------------------------------------------------------- #
# Settings: accrual tiers
# --------------------------------------------------------------------------- #


def load_tiers(session) -> list[AccrualTier]:
    return list(
        session.exec(select(AccrualTier).order_by(AccrualTier.starts_on)).all()
    )


def create_tier(
    session, d: date, annual_days: float, annual_hours: float, label: str
) -> None:
    """Idempotent-on-start-date insert of an accrual tier."""
    exists = session.exec(select(AccrualTier).where(AccrualTier.starts_on == d)).first()
    if exists is None:
        session.add(
            AccrualTier(
                starts_on=d,
                annual_days=annual_days,
                annual_hours=annual_hours,
                label=label.strip() or d.isoformat(),
            )
        )
        session.commit()


def update_tier(
    session,
    tier_id: int,
    d: date,
    annual_days: float,
    annual_hours: float,
    label: str,
) -> None:
    tier = session.get(AccrualTier, tier_id)
    if tier is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"tier {tier_id} not found",
        )
    tier.starts_on = d
    tier.annual_days = annual_days
    tier.annual_hours = annual_hours
    tier.label = label.strip() or d.isoformat()
    session.add(tier)
    session.commit()


def remove_tier(session, tier_id: int) -> None:
    """Delete a tier, guarding the last one (the engine needs at least a rate)."""
    if len(load_tiers(session)) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="at least one accrual tier must remain",
        )
    tier = session.get(AccrualTier, tier_id)
    if tier is not None:
        session.delete(tier)
        session.commit()
