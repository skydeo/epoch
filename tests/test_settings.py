"""Settings — seed idempotency, constants form, holidays, tier guard.

The interesting assertions are behavioral: a settings edit must change what the
*engine* computes (the DB is the single source of truth for the constants), and
a holiday edit must change how a usage range expands.
"""

from __future__ import annotations

from datetime import date

from sqlmodel import select

from epoch.db import get_session
from epoch.domain import load_engine_config
from epoch.engine import compute_ledger
from epoch.models import AccrualTier, AppSetting, CompanyHoliday, UsageEntry
from epoch.seed import DEFAULT_SETTINGS, seed_defaults


def _settings_form(**overrides) -> dict[str, str]:
    """A complete constants form from the seeded defaults.

    ``round_period_accrual`` is a checkbox: any present value reads as true.
    """
    form = dict(DEFAULT_SETTINGS)
    form["round_period_accrual"] = "on"
    form.update(overrides)
    return form


def _setting(key: str) -> str:
    with get_session() as session:
        return session.get(AppSetting, key).value


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
# Constants form
# --------------------------------------------------------------------------- #


def test_save_settings_redirects_and_persists(client):
    resp = client.post(
        "/settings",
        data=_settings_form(rollover_hours="250"),
        follow_redirects=False,
    )
    assert resp.status_code == 303
    assert resp.headers["location"] == "/settings?saved=1"
    assert _setting("rollover_hours") == "250"

    page = client.get("/settings?saved=1")
    assert "Settings saved." in page.text


def test_save_settings_rejects_bad_values(client):
    """Non-positive numerics and unparseable dates 400 without saving."""
    resp = client.post(
        "/settings",
        data=_settings_form(max_balance_hours="-5", hire_date="not-a-date"),
    )
    assert resp.status_code == 400
    assert "must be greater than 0" in resp.text
    assert "not a valid date" in resp.text
    # Nothing was persisted.
    assert _setting("max_balance_hours") == "360"
    assert _setting("hire_date") == "2023-01-09"


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

    resp = client.post(
        "/settings", data=_settings_form(max_balance_hours="2000"),
        follow_redirects=False,
    )
    assert resp.status_code == 303

    with get_session() as session:
        cfg2 = load_engine_config(session)
    assert cfg2.max_balance_hours == 2000.0
    lost_raised = sum(r.lost_to_cap for r in compute_ledger(cfg2, [], through))
    assert lost_raised < lost_default
    assert lost_raised == 0


# --------------------------------------------------------------------------- #
# Company holidays
# --------------------------------------------------------------------------- #


def _usage_count() -> int:
    with get_session() as session:
        return len(session.exec(select(UsageEntry)).all())


def test_holiday_add_and_delete_affect_range_expansion(client):
    """An added holiday is skipped by /usage range expansion; deleting it
    restores the day. (2026-08-10..14 is a Mon–Fri week with no seeded holiday.)
    """
    resp = client.post(
        "/settings/holidays", data={"date": "2026-08-12", "name": "Test Day"}
    )
    assert resp.status_code == 200
    assert "Test Day" in resp.text

    resp = client.post(
        "/usage", data={"start": "2026-08-10", "end": "2026-08-14", "type": "pto"}
    )
    assert resp.status_code == 201
    assert _usage_count() == 4  # Wed skipped

    with get_session() as session:
        holiday = session.exec(
            select(CompanyHoliday).where(CompanyHoliday.date == date(2026, 8, 12))
        ).one()
        holiday_id = holiday.id

    resp = client.delete(f"/settings/holidays/{holiday_id}")
    assert resp.status_code == 200
    assert "Test Day" not in resp.text

    resp = client.post(
        "/usage", data={"start": "2026-08-10", "end": "2026-08-14", "type": "pto"}
    )
    assert resp.status_code == 201
    assert _usage_count() == 4 + 5  # full week now


def test_holiday_add_is_idempotent_on_date(client):
    with get_session() as session:
        before = len(session.exec(select(CompanyHoliday)).all())
    client.post("/settings/holidays", data={"date": "2026-08-12", "name": "A"})
    client.post("/settings/holidays", data={"date": "2026-08-12", "name": "B"})
    with get_session() as session:
        assert len(session.exec(select(CompanyHoliday)).all()) == before + 1


# --------------------------------------------------------------------------- #
# Accrual tiers
# --------------------------------------------------------------------------- #


def _tier_ids() -> list[int]:
    with get_session() as session:
        return [
            t.id
            for t in session.exec(
                select(AccrualTier).order_by(AccrualTier.starts_on)
            ).all()
        ]


def test_tier_edit_changes_engine_rate(client):
    """Editing the hire tier's annual hours changes the accrual rate."""
    tier_id = _tier_ids()[0]
    resp = client.post(
        f"/settings/tiers/{tier_id}",
        data={
            "starts_on": "2023-01-09",
            "annual_days": "26",
            "annual_hours": "208",
            "label": "26 days/yr",
        },
    )
    assert resp.status_code == 200

    with get_session() as session:
        cfg = load_engine_config(session)
    from epoch.engine import accrual_rate

    assert accrual_rate(cfg, date(2026, 7, 19)) == 8.0  # 208 / 26


def test_tier_add_and_delete(client):
    resp = client.post(
        "/settings/tiers",
        data={
            "starts_on": "2038-01-09",
            "annual_days": "37",
            "annual_hours": "296",
            "label": "37 days/yr (15 years)",
        },
    )
    assert resp.status_code == 200
    assert "37 days/yr (15 years)" in resp.text
    assert len(_tier_ids()) == 4

    new_id = _tier_ids()[-1]
    resp = client.delete(f"/settings/tiers/{new_id}")
    assert resp.status_code == 200
    assert len(_tier_ids()) == 3


def test_last_tier_cannot_be_deleted(client):
    ids = _tier_ids()
    assert len(ids) == 3
    for tier_id in ids[:-1]:
        assert client.delete(f"/settings/tiers/{tier_id}").status_code == 200
    resp = client.delete(f"/settings/tiers/{ids[-1]}")
    assert resp.status_code == 400
    assert len(_tier_ids()) == 1
