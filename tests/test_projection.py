"""Projection page + result partial.

``balance_on`` itself is engine-tested; here we assert the *route* contract:
exact sheet-derived balances render for a known date, pre-hire dates 400 with a
message, and a lossy future span surfaces forfeiture warnings.
"""

from __future__ import annotations

from datetime import date

from epoch.db import get_session
from epoch.models import UsageEntry, UsageType


def test_projection_result_known_past_date(client):
    """With one 8 h PTO day on 2026-03-03, the balance on 2026-07-08 is 333.55.

    (Empty-usage balance on 2026-07-08 is 341.55 — period 92 end-of-period —
    minus the 8 h used.) Independently derived from the engine's seeded
    constants; the route must render it exactly.
    """
    with get_session() as session:
        session.add(UsageEntry(date=date(2026, 3, 3), hours=8, type=UsageType.pto))
        session.commit()

    resp = client.get("/projection/result", params={"date": "2026-07-08"})
    assert resp.status_code == 200
    assert "333.55" in resp.text
    assert "2026-07-06" in resp.text  # containing period bounds (period 92)
    assert "2026-07-19" in resp.text
    assert "#92" in resp.text
    assert "pay period containing the selected date" in resp.text


def test_projection_result_no_usage(client):
    resp = client.get("/projection/result", params={"date": "2026-07-08"})
    assert resp.status_code == 200
    assert "341.55" in resp.text


def test_projection_pre_hire_date_400(client):
    resp = client.get("/projection/result", params={"date": "2022-12-25"})
    assert resp.status_code == 400
    assert "precedes the hire date" in resp.text


def test_projection_malformed_date_400(client):
    resp = client.get("/projection/result", params={"date": "not-a-date"})
    assert resp.status_code == 400
    assert "not a valid date" in resp.text


def test_projection_future_date_includes_loss_warnings(client):
    """With no usage the balance rides the cap and forfeits at every year-end
    rollover, so a far-future projection must surface both warning kinds.
    """
    resp = client.get("/projection/result", params={"date": "2030-12-31"})
    assert resp.status_code == 200
    assert "Forfeiture warnings" in resp.text
    assert "lost to the" in resp.text  # cap loss
    assert "forfeited at year-end rollover" in resp.text


def test_projection_ph_bucket_for_target_year(client):
    """PH remaining reflects the *target* date's calendar year."""
    with get_session() as session:
        session.add(
            UsageEntry(
                date=date(2026, 3, 3), hours=16, type=UsageType.personal_holiday
            )
        )
        session.commit()

    used_up = client.get("/projection/result", params={"date": "2026-07-08"})
    assert "16 of 16 h used" in used_up.text

    next_year = client.get("/projection/result", params={"date": "2027-07-08"})
    assert "0 of 16 h used" in next_year.text
