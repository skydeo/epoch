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
    period_bounds,
    period_index_for,
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
# Phase 6 stubs — keep the nav from 404-ing until those pages land.
# --------------------------------------------------------------------------- #


def _stub(request: Request, active: str, title: str) -> HTMLResponse:
    return templates.TemplateResponse(
        request,
        "stub.html",
        {"active_page": active, "stub_title": title},
    )


@router.get("/projection", response_class=HTMLResponse)
async def projection_stub(request: Request) -> HTMLResponse:
    return _stub(request, "projection", "Projection")


@router.get("/settings", response_class=HTMLResponse)
async def settings_stub(request: Request) -> HTMLResponse:
    return _stub(request, "settings", "Settings")


@router.get("/import", response_class=HTMLResponse)
async def import_stub(request: Request) -> HTMLResponse:
    return _stub(request, "import", "Import")
