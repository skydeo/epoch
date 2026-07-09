"""Server-rendered full pages.

Every page here runs the pure accrual engine once against the current DB state
and hands the folded rows to a Jinja template. Nothing derived is persisted; the
ledger is recomputed per request (microseconds). "Today" is read from the clock
*only* at this layer and passed into the engine as a parameter — the engine
itself stays clock-free.

The Projection / Settings / Import pages are fully built in Phase 6; here they
are lightweight stubs so the shared nav never 404s.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
from sqlmodel import select

from epoch.db import get_session
from epoch.domain import load_engine_config, load_usage
from epoch.engine import (
    EngineConfig,
    PeriodRow,
    accrual_rate,
    balance_on,
    compute_ledger,
    loss_warnings,
    period_bounds,
    period_index_for,
    yearly_stats,
)
from epoch.models import UsageEntry
from epoch.templating import templates

router = APIRouter(tags=["pages"])


def _today() -> date:
    """The clock read — isolated so the engine stays deterministic."""
    return date.today()


def _row_state(row: PeriodRow, today: date) -> str:
    """`period-past` / `period-current` / `period-future` for a ledger row."""
    if today < row.start:
        return "period-future"
    if today > row.end:
        return "period-past"
    return "period-current"


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


def _dashboard_stats(cfg: EngineConfig, usage, today: date) -> dict:
    """Compute every stat card from a single ledger fold through today."""
    ledger = compute_ledger(cfg, usage, today)
    snap = balance_on(cfg, usage, today)
    current = ledger[-1]

    max_balance = max((r.balance for r in ledger), default=0.0)
    pct_of_cap = (
        (current.balance / cfg.max_balance_hours * 100.0)
        if cfg.max_balance_hours
        else 0.0
    )
    pto_used_ytd = round(
        sum(r.pto_used for r in ledger if r.end.year == today.year), 2
    )

    # Next pay: earliest period (from the current one onward) whose pay date
    # has not yet passed.
    next_pay_date = None
    next_pay_accrual = 0.0
    idx = current.index
    for _ in range(3):  # current + a couple ahead is always enough
        start, end, pay = period_bounds(cfg, idx)
        if pay >= today:
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
        "year": today.year,
        "warnings": snap.warnings,
    }


@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request) -> HTMLResponse:
    """Stat cards (server-rendered) + the accrual/usage chart canvas."""
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)
    stats = _dashboard_stats(cfg, usage, today)
    return templates.TemplateResponse(
        request,
        "dashboard.html",
        {"active_page": "dashboard", "stats": stats, "today": today},
    )


# --------------------------------------------------------------------------- #
# Accruals
# --------------------------------------------------------------------------- #


@router.get("/accruals", response_class=HTMLResponse)
async def accruals(request: Request, year: int | None = None) -> HTMLResponse:
    """One row per pay period, with past/current/future state classes.

    Folds the ledger through today (so the current period and its balance are
    real, not projected). An optional ``?year=`` narrows the visible rows to a
    single calendar year; the current period is still highlighted and anchored.
    """
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    ledger = compute_ledger(cfg, usage, today)
    current_index = period_index_for(cfg, today)

    view = [r for r in ledger if year is None or r.end.year == year]
    rows = [
        {"row": r, "state": _row_state(r, today), "is_current": r.index == current_index}
        for r in view
    ]
    years = sorted({r.end.year for r in ledger})

    return templates.TemplateResponse(
        request,
        "accruals.html",
        {
            "active_page": "accruals",
            "rows": rows,
            "years": years,
            "selected_year": year,
            "current_index": current_index,
        },
    )


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #


@router.get("/usage", response_class=HTMLResponse)
async def usage_page(request: Request) -> HTMLResponse:
    """The usage log: entry form on top, filter bar, and the editable table."""
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        entries = list(session.exec(select(UsageEntry)).all())

    entries.sort(key=lambda e: (e.date, e.id or 0))
    years = sorted({e.date.year for e in entries})

    return templates.TemplateResponse(
        request,
        "usage.html",
        {
            "active_page": "usage",
            "rows": entries,
            "years": years,
            "today": today,
            "hire_date": cfg.hire_date,
            "hours_per_day": cfg.hours_per_day,
        },
    )


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


def _horizon(cfg: EngineConfig, today: date) -> date:
    """today + the configured projection horizon (whole-month, stdlib only)."""
    total = today.year * 12 + (today.month - 1) + cfg.projection_horizon_months
    year, month = divmod(total, 12)
    return date(year, month + 1, min(today.day, 28))


def _projection_snapshot(cfg: EngineConfig, usage, today: date, target: date) -> dict:
    """Balance snapshot + span warnings for a projection to ``target``.

    ``balance_on(target)`` gives the end-of-period balance of the period
    *containing* ``target``; span warnings scan the ledger rows overlapping the
    window between today and the target for cap / rollover forfeitures.
    """
    snap = balance_on(cfg, usage, target)
    p_start, p_end, p_pay = period_bounds(cfg, snap.period)

    lo, hi = min(today, target), max(today, target)
    span_rows = [
        r
        for r in compute_ledger(cfg, usage, hi)
        if r.end >= lo and r.start <= hi
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
        "today": today,
        "is_future": target > today,
    }


@router.get("/projection", response_class=HTMLResponse)
async def projection(request: Request) -> HTMLResponse:
    """Date picker + an initial snapshot for today, plus the per-year stats table."""
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    result = _projection_snapshot(cfg, usage, today, today)
    stats = yearly_stats(cfg, usage, max(today, _horizon(cfg, today)))

    return templates.TemplateResponse(
        request,
        "projection.html",
        {
            "active_page": "projection",
            "result": result,
            "stats": stats,
            "today": today,
            "hire_date": cfg.hire_date,
        },
    )


@router.get("/projection/result", response_class=HTMLResponse)
async def projection_result(request: Request, date: str) -> HTMLResponse:  # noqa: A002
    """HTMX partial: the snapshot for a selected date (≥ hire date).

    Returns a 400 partial (with a message) for an unparseable date or a date
    before the hire date — the engine has no period for it.
    """
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    try:
        target = date_from_iso(date)
    except ValueError:
        return templates.TemplateResponse(
            request,
            "_projection_result.html",
            {"error": f"{date!r} is not a valid date."},
            status_code=400,
        )
    if target < cfg.hire_date:
        return templates.TemplateResponse(
            request,
            "_projection_result.html",
            {
                "error": (
                    f"Date {target.isoformat()} precedes the hire date "
                    f"{cfg.hire_date.isoformat()} — no pay period exists."
                )
            },
            status_code=400,
        )

    result = _projection_snapshot(cfg, usage, today, target)
    return templates.TemplateResponse(
        request, "_projection_result.html", {"result": result}
    )


def date_from_iso(value: str) -> date:
    """Parse an ISO date, raising ``ValueError`` on anything malformed."""
    return date.fromisoformat(value)


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #


@router.get("/import", response_class=HTMLResponse)
async def import_page(request: Request) -> HTMLResponse:
    """Upload form (→ preview partial), an export link, and format docs."""
    return templates.TemplateResponse(
        request, "import.html", {"active_page": "import"}
    )
