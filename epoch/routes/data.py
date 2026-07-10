"""JSON data endpoints consumed by the SPA's dashboard chart and stats tables.

The server does *all* the math here — the client only draws. ``/api/chart``
returns parallel arrays keyed by pay-period start date (mirroring the source
spreadsheet's chart); ``/api/stats`` returns per-calendar-year rollups. Range
presets (YTD / 1yr / All / custom) are just ``start`` / ``end`` query params that
window which periods are returned.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from epoch.db import get_session
from epoch.domain import load_engine_config, load_usage
from epoch.engine import (
    PeriodRow,
    compute_ledger,
    period_index_for,
    yearly_stats,
)
from epoch.services import horizon

router = APIRouter(prefix="/api", tags=["data"])


@router.get("/chart")
async def chart_data(start: str | None = None, end: str | None = None) -> dict:
    """Parallel arrays for the dashboard chart.

    ``{labels, balance[], pto_used[], ph_used[], max_accrued, cap, today_index}``.
    ``labels`` are period start dates (ISO). ``today_index`` is the 0-based
    position of the current period within the returned window, or ``-1`` if the
    window excludes today. The optional ``start`` / ``end`` (ISO dates) clip the
    window to periods whose *start* falls in ``[start, end]``.
    """
    today = date.today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    through = max(today, horizon(cfg, today))
    ledger = compute_ledger(cfg, usage, through)

    start_d = date.fromisoformat(start) if start else None
    end_d = date.fromisoformat(end) if end else None

    def in_window(row: PeriodRow) -> bool:
        if start_d and row.start < start_d:
            return False
        if end_d and row.start > end_d:
            return False
        return True

    window = [r for r in ledger if in_window(r)]

    current_index = period_index_for(cfg, today)
    today_index = next(
        (i for i, r in enumerate(window) if r.index == current_index), -1
    )

    # max_accrued is the peak balance over the *full* history (matches the
    # sheet's "Max PTO Accrued" horizontal line), not just the visible window.
    max_accrued = max((r.balance for r in ledger), default=0.0)

    # Calendar years available for the chart's year filter — hire year through
    # the current year, newest first (2026, 2025, …). Independent of the window
    # so the dropdown stays fully populated even when a preset/year clips it.
    years = list(range(today.year, cfg.hire_date.year - 1, -1))

    return {
        "labels": [r.start.isoformat() for r in window],
        "balance": [r.balance for r in window],
        "pto_used": [r.pto_used for r in window],
        "ph_used": [r.ph_used for r in window],
        "max_accrued": round(max_accrued, 2),
        "cap": cfg.max_balance_hours,
        "today_index": today_index,
        "years": years,
    }


@router.get("/stats")
async def stats_data() -> dict:
    """Per-calendar-year totals: accrued, PTO used, PH used, lost to cap/rollover."""
    today = date.today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    through = max(today, horizon(cfg, today))
    years = yearly_stats(cfg, usage, through)
    return {
        "years": [
            {
                "year": y.year,
                "accrued": y.accrued,
                "pto_used": y.pto_used,
                "ph_used": y.ph_used,
                "lost_to_cap": y.lost_to_cap,
                "lost_to_rollover": y.lost_to_rollover,
            }
            for y in years
        ]
    }
