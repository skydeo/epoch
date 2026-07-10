"""Projection API — sheet-derived balances and forfeiture warnings.

``balance_on`` itself is engine-tested; here we assert the *route* contract on
top of ``test_api.py``'s shape/error coverage: the exact empty-usage balance
for a known date, loss warnings over a lossy future span, and the PH bucket
following the target date's calendar year.
"""

from __future__ import annotations

from datetime import date

from epoch.db import get_session
from epoch.models import UsageEntry, UsageType


def test_projection_no_usage_known_value(client):
    """Empty-usage balance on 2026-07-08 is 341.55 (period 92, end-of-period).

    Independently derived from the engine's seeded constants; the route must
    return it exactly.
    """
    data = client.get("/api/projection", params={"date": "2026-07-08"}).json()
    assert data["snap"]["pto_balance"] == 341.55
    assert data["snap"]["period"] == 92
    assert data["period_start"] == "2026-07-06"
    assert data["period_end"] == "2026-07-19"


def test_projection_future_date_includes_loss_warnings(client):
    """With no usage the balance rides the cap and forfeits at every year-end
    rollover, so a far-future projection must surface both warning kinds.
    """
    data = client.get("/api/projection", params={"date": "2030-12-31"}).json()
    warnings = data["warnings"]
    assert any("lost to the" in w for w in warnings)  # cap loss
    assert any("forfeited at year-end rollover" in w for w in warnings)


def test_projection_ph_bucket_for_target_year(client):
    """PH remaining reflects the *target* date's calendar year."""
    with get_session() as session:
        session.add(
            UsageEntry(
                date=date(2026, 3, 3), hours=16, type=UsageType.personal_holiday
            )
        )
        session.commit()

    used_up = client.get("/api/projection", params={"date": "2026-07-08"}).json()
    assert used_up["snap"]["ph_used"] == 16.0
    assert used_up["snap"]["ph_remaining"] == 0.0

    next_year = client.get("/api/projection", params={"date": "2027-07-08"}).json()
    assert next_year["snap"]["ph_used"] == 0.0
    assert next_year["snap"]["ph_remaining"] == 16.0
