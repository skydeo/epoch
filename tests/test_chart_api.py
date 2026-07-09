"""Dashboard JSON endpoints + page smoke tests.

The chart/stats math is the engine's (covered exhaustively in ``test_engine``);
here we assert the *API contract* the frontend depends on — array shapes, range
windowing, ``today_index`` placement — and that every page renders its key
element.
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


def test_chart_today_index(client):
    """today_index points at the period whose [start, start+13] contains today."""
    data = client.get("/api/chart").json()
    idx = data["today_index"]
    assert idx >= 0
    start = date.fromisoformat(data["labels"][idx])
    today = date.today()
    assert start <= today <= start + timedelta(days=13)


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
        "ph_used",
        "lost_to_cap",
        "lost_to_rollover",
    }
    # 2026 must show the PTO/PH we seeded.
    by_year = {r["year"]: r for r in data["years"]}
    assert by_year[2026]["pto_used"] >= 8
    assert by_year[2026]["ph_used"] >= 8


# --------------------------------------------------------------------------- #
# Pages — 200 + key element present
# --------------------------------------------------------------------------- #


def test_dashboard_page(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert 'id="pto-chart"' in resp.text  # the chart canvas
    assert "Current PTO" in resp.text  # a stat card


def test_accruals_page(client):
    resp = client.get("/accruals")
    assert resp.status_code == 200
    assert "ledger-table" in resp.text  # the period table
    assert "period-current" in resp.text  # current period is highlighted


def test_accruals_year_filter(client):
    resp = client.get("/accruals", params={"year": 2026})
    assert resp.status_code == 200
    assert "2026-" in resp.text
    assert "2024-" not in resp.text


def test_usage_page(client):
    resp = client.get("/usage")
    assert resp.status_code == 200
    assert 'hx-post="/usage"' in resp.text  # the new-entry range form


def test_projection_page(client):
    resp = client.get("/projection")
    assert resp.status_code == 200
    assert 'hx-get="/projection/result"' in resp.text  # the date picker form
    assert "Projected PTO balance" in resp.text  # initial (today) snapshot
    assert "Per-year stats" in resp.text  # the yearly_stats table
    assert "Lost to rollover" in resp.text


def test_settings_page(client):
    resp = client.get("/settings")
    assert resp.status_code == 200
    assert 'name="max_balance_hours"' in resp.text  # a constants field
    assert 'hx-post="/settings/holidays"' in resp.text  # holiday add form
    assert 'hx-post="/settings/tiers"' in resp.text  # tier add form
    assert "22 days/yr (hire)" in resp.text  # seeded tier rendered


def test_import_page(client):
    resp = client.get("/import")
    assert resp.status_code == 200
    assert 'hx-post="/import/csv"' in resp.text  # the upload form
    assert 'href="/export/csv"' in resp.text  # the export link
    assert "0-hour rows are skipped" in resp.text  # format docs
