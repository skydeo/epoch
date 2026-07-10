"""Settings — seed idempotency plus the behavioral contracts of the API.

The interesting assertions are behavioral: a settings edit must change what the
*engine* computes (the DB is the single source of truth for the constants), and
a holiday edit must change how a usage range expands. Shape/validation coverage
for the same endpoints lives in ``test_api.py``.
"""

from __future__ import annotations

from datetime import date

from sqlmodel import select

from epoch.db import get_session
from epoch.domain import load_engine_config
from epoch.engine import accrual_rate, compute_ledger
from epoch.models import AccrualTier, AppSetting, CompanyHoliday, UsageEntry
from epoch.seed import DEFAULT_SETTINGS, seed_defaults


def _settings_body(**overrides) -> dict[str, str]:
    """A complete constants payload built from the seeded defaults."""
    body = dict(DEFAULT_SETTINGS)
    body.update(overrides)
    return body


# --------------------------------------------------------------------------- #
# Seed idempotency
# --------------------------------------------------------------------------- #


def test_seed_idempotent_and_user_edit_survives(client):
    """Re-running the seed adds nothing and never overwrites a user edit."""
    with get_session() as session:
        n_settings = len(session.exec(select(AppSetting)).all())
        n_tiers = len(session.exec(select(AccrualTier)).all())
        n_holidays = len(session.exec(select(CompanyHoliday)).all())

        # User edits a constant...
        row = session.get(AppSetting, "max_balance_hours")
        row.value = "400"
        session.add(row)
        session.commit()

        # ...and a restart re-seeds.
        seed_defaults(session)

        assert session.get(AppSetting, "max_balance_hours").value == "400"
        assert len(session.exec(select(AppSetting)).all()) == n_settings
        assert len(session.exec(select(AccrualTier)).all()) == n_tiers
        assert len(session.exec(select(CompanyHoliday)).all()) == n_holidays


# --------------------------------------------------------------------------- #
# Constants → engine behavior
# --------------------------------------------------------------------------- #


def test_raising_cap_reduces_lost_to_cap(client):
    """A settings edit changes engine output: a higher cap forfeits less.

    With no usage the balance accrues into the 360 h cap well before the end of
    2027; raising the cap far above one year's max possible balance
    (rollover 240 + annual 176) eliminates cap losses entirely.
    """
    through = date(2027, 12, 31)
    with get_session() as session:
        cfg = load_engine_config(session)
    lost_default = sum(r.lost_to_cap for r in compute_ledger(cfg, [], through))
    assert lost_default > 0

    resp = client.put("/api/settings", json=_settings_body(max_balance_hours="2000"))
    assert resp.status_code == 200
    assert resp.json() == {"saved": True}

    with get_session() as session:
        cfg2 = load_engine_config(session)
    assert cfg2.max_balance_hours == 2000.0
    lost_raised = sum(r.lost_to_cap for r in compute_ledger(cfg2, [], through))
    assert lost_raised < lost_default
    assert lost_raised == 0


# --------------------------------------------------------------------------- #
# Company holidays → range expansion
# --------------------------------------------------------------------------- #


def _usage_count() -> int:
    with get_session() as session:
        return len(session.exec(select(UsageEntry)).all())


def test_holiday_add_and_delete_affect_range_expansion(client):
    """An added holiday is skipped by usage range expansion; deleting it
    restores the day. (2026-08-10..14 is a Mon–Fri week with no seeded holiday.)
    """
    resp = client.post(
        "/api/settings/holidays", json={"date": "2026-08-12", "name": "Test Day"}
    )
    assert resp.status_code == 200
    added = [h for h in resp.json()["holidays"] if h["date"] == "2026-08-12"]
    assert added and added[0]["name"] == "Test Day"
    holiday_id = added[0]["id"]

    resp = client.post(
        "/api/usage", json={"start": "2026-08-10", "end": "2026-08-14", "type": "pto"}
    )
    assert resp.status_code == 201
    assert _usage_count() == 4  # Wed skipped

    resp = client.delete(f"/api/settings/holidays/{holiday_id}")
    assert resp.status_code == 200
    assert all(h["date"] != "2026-08-12" for h in resp.json()["holidays"])

    resp = client.post(
        "/api/usage", json={"start": "2026-08-10", "end": "2026-08-14", "type": "pto"}
    )
    assert resp.status_code == 201
    assert _usage_count() == 4 + 5  # full week now


def test_holiday_add_is_idempotent_on_date(client):
    with get_session() as session:
        before = len(session.exec(select(CompanyHoliday)).all())
    client.post("/api/settings/holidays", json={"date": "2026-08-12", "name": "A"})
    client.post("/api/settings/holidays", json={"date": "2026-08-12", "name": "B"})
    with get_session() as session:
        assert len(session.exec(select(CompanyHoliday)).all()) == before + 1


# --------------------------------------------------------------------------- #
# Accrual tiers → engine rate
# --------------------------------------------------------------------------- #


def test_tier_edit_changes_engine_rate(client):
    """Editing the hire tier's annual hours changes the accrual rate."""
    with get_session() as session:
        tier_id = [
            t.id
            for t in session.exec(
                select(AccrualTier).order_by(AccrualTier.starts_on)
            ).all()
        ][0]

    resp = client.put(
        f"/api/settings/tiers/{tier_id}",
        json={
            "starts_on": "2023-01-09",
            "annual_days": 26,
            "annual_hours": 208,
            "label": "26 days/yr",
        },
    )
    assert resp.status_code == 200

    with get_session() as session:
        cfg = load_engine_config(session)
    assert accrual_rate(cfg, date(2026, 7, 19)) == 8.0  # 208 / 26
