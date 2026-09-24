"""Dashboard chart/stats JSON endpoints.

The chart/stats math is the engine's (covered exhaustively in ``test_engine``);
here we assert the *API contract* the SPA chart depends on — array shapes,
range windowing, ``today_index`` placement.
"""

from __future__ import annotations

from datetime import date, timedelta

from epoch.db import get_session
from epoch.models import UsageEntry, UsageType

CHART_KEYS = {
    "labels",
    "balance",
    "pto_used",
    "ph_used",
    "max_accrued",
    "cap",
    "today_index",
    "years",
}


def _seed_usage(client) -> None:
    """A little PTO + PH so the arrays carry signal."""
    with get_session() as session:
        session.add(UsageEntry(date=date(2026, 3, 2), hours=8, type=UsageType.pto))
        session.add(
            UsageEntry(
                date=date(2026, 3, 3), hours=8, type=UsageType.personal_holiday
            )
        )
        session.commit()


# --------------------------------------------------------------------------- #
# /api/chart
# --------------------------------------------------------------------------- #


def test_chart_shape(client):
    _seed_usage(client)
    data = client.get("/api/chart").json()

    assert set(data.keys()) == CHART_KEYS
    n = len(data["labels"])
    assert n > 0
    # Every parallel array is the same length as labels.
    for key in ("balance", "pto_used", "ph_used"):
        assert len(data[key]) == n
    # Labels are ISO period-start dates, strictly increasing.
    parsed = [date.fromisoformat(x) for x in data["labels"]]
    assert parsed == sorted(parsed)
    assert data["cap"] == 360.0
    assert data["max_accrued"] > 0


def test_chart_max_accrued_matches_dashboard(client):
    """max_accrued is the peak balance ever reached (through the current
    period), identical to the dashboard's max_balance stat — never inflated
    by future projected periods."""
    _seed_usage(client)
    chart = client.get("/api/chart").json()
    dashboard = client.get("/api/dashboard").json()

    assert chart["max_accrued"] == dashboard["max_balance"]
    # Projected future balances never drag the reference line above the peak
    # actually reached (they can only match it, e.g. when capped).
    assert max(chart["balance"]) >= chart["max_accrued"]


def test_chart_today_index(client):
    """today_index points at the period whose [start, start+13] contains today."""
    data = client.get("/api/chart").json()
    idx = data["today_index"]
    assert idx >= 0
    start = date.fromisoformat(data["labels"][idx])
    today = date.today()
    assert start <= today <= start + timedelta(days=13)


def test_chart_years(client):
    """`years` lists calendar years newest-first, from hire year to this year."""
    data = client.get("/api/chart").json()
    years = data["years"]
    assert years, "expected at least one year"
    assert years == sorted(years, reverse=True)
    assert date.today().year in years


def test_chart_range_filtering(client):
    """A start filter drops earlier periods; an out-of-range window empties."""
    full = client.get("/api/chart").json()
    assert len(full["labels"]) > 10

    windowed = client.get("/api/chart", params={"start": "2026-01-01"}).json()
    assert all(
        date.fromisoformat(x) >= date(2026, 1, 1) for x in windowed["labels"]
    )
    assert len(windowed["labels"]) < len(full["labels"])

    # Bounded window: start+end both in 2026.
    both = client.get(
        "/api/chart", params={"start": "2026-01-01", "end": "2026-12-31"}
    ).json()
    assert all(
        date(2026, 1, 1) <= date.fromisoformat(x) <= date(2026, 12, 31)
        for x in both["labels"]
    )

    # A window entirely before the hire date yields no periods and today_index -1.
    empty = client.get(
        "/api/chart", params={"start": "2000-01-01", "end": "2000-02-01"}
    ).json()
    assert empty["labels"] == []
    assert empty["today_index"] == -1


# --------------------------------------------------------------------------- #
# /api/stats
# --------------------------------------------------------------------------- #


def test_stats_shape(client):
    _seed_usage(client)
    data = client.get("/api/stats").json()
    assert "years" in data
    assert data["years"], "expected at least one year of stats"
    row = data["years"][0]
    assert set(row.keys()) == {
        "year",
        "accrued",
        "pto_used",
        "pto_taken",
        "pto_planned",
        "ph_used",
        "ph_granted",
        "ph_remaining",
        "lost_to_cap",
        "lost_to_rollover",
        "end_balance",
        "partial",
    }
    # 2026 must show the PTO/PH we seeded.
    by_year = {r["year"]: r for r in data["years"]}
    assert by_year[2026]["pto_used"] >= 8
    assert by_year[2026]["ph_used"] >= 8
