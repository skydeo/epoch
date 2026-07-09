"""JSON API layer (``routes/api.py``) — the contract the SPA depends on.

Mirrors the existing HTML-route tests but asserts JSON shapes: dashboard/
projection payload keys, accruals rows + state, usage CRUD (range expansion,
partial patch for edit and the requested toggle, delete), settings get/put and
holiday/tier mutations, and the import preview → confirm flow. Serialization
formats (ISO dates, ``UsageType.value``) are checked explicitly.
"""

from __future__ import annotations

from datetime import date

from sqlmodel import select

from epoch.db import get_session
from epoch.models import AccrualTier, CompanyHoliday, UsageEntry, UsageType
from epoch.seed import DEFAULT_SETTINGS


def _all_entries():
    with get_session() as session:
        return list(session.exec(select(UsageEntry).order_by(UsageEntry.date)).all())


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #

DASHBOARD_KEYS = {
    "current_balance",
    "current_balance_negative",
    "ph_remaining",
    "ph_granted",
    "max_balance",
    "pct_of_cap",
    "cap",
    "pto_used_ytd",
    "next_pay_date",
    "next_pay_accrual",
    "year",
    "warnings",
}


def test_dashboard_payload(client):
    data = client.get("/api/dashboard").json()
    assert set(data.keys()) == DASHBOARD_KEYS
    assert data["cap"] == 360.0
    assert isinstance(data["warnings"], list)
    # next_pay_date is an ISO string (or null); here there is always a next pay.
    assert isinstance(data["next_pay_date"], str)
    date.fromisoformat(data["next_pay_date"])  # parses


# --------------------------------------------------------------------------- #
# Accruals
# --------------------------------------------------------------------------- #


def test_accruals_rows_state_and_current(client):
    data = client.get("/api/accruals").json()
    assert set(data.keys()) == {"rows", "years", "current_index"}
    assert data["rows"], "expected folded ledger rows"

    states = {r["state"] for r in data["rows"]}
    assert states <= {"past", "current", "future"}

    current_rows = [r for r in data["rows"] if r["is_current"]]
    assert len(current_rows) == 1
    assert current_rows[0]["index"] == data["current_index"]
    assert current_rows[0]["state"] == "current"

    # A row carries the engine fields as ISO dates / numbers.
    row = data["rows"][0]
    date.fromisoformat(row["start"])
    date.fromisoformat(row["end"])
    date.fromisoformat(row["pay_date"])
    assert isinstance(row["balance"], (int, float))


def test_accruals_year_filter(client):
    data = client.get("/api/accruals", params={"year": 2026}).json()
    assert data["rows"]
    assert all(r["end"].startswith("2026-") for r in data["rows"])


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #


def test_usage_list_shape_and_serialization(client):
    client.post(
        "/api/usage",
        json={"start": "2026-07-13", "end": "2026-07-13", "type": "personal_holiday"},
    )
    data = client.get("/api/usage").json()
    assert set(data.keys()) == {"rows", "years", "hire_date", "hours_per_day"}
    assert data["hire_date"] == "2023-01-09"
    assert data["hours_per_day"] == 8.0

    row = data["rows"][0]
    assert set(row.keys()) == {"id", "date", "hours", "type", "reason", "requested"}
    assert row["date"] == "2026-07-13"
    assert row["type"] == "personal_holiday"  # UsageType serialized as .value
    assert row["requested"] is False


def test_usage_create_range_expansion(client):
    """Mon–Sun with a Wednesday holiday → 4 rows (Mon/Tue/Thu/Fri), 201."""
    with get_session() as session:
        session.add(CompanyHoliday(date=date(2026, 7, 15), name="Test Holiday"))
        session.commit()

    resp = client.post(
        "/api/usage", json={"start": "2026-07-13", "end": "2026-07-19", "type": "pto"}
    )
    assert resp.status_code == 201
    created = resp.json()["created"]
    assert len(created) == 4
    assert [r["date"] for r in created] == [
        "2026-07-13",
        "2026-07-14",
        "2026-07-16",
        "2026-07-17",
    ]
    assert all(r["hours"] == 8.0 for r in created)
    assert all(r["type"] == "pto" for r in created)


def test_usage_create_pre_hire_400(client):
    resp = client.post("/api/usage", json={"start": "2022-12-01", "end": "2022-12-02"})
    assert resp.status_code == 400
    assert not _all_entries()


def test_usage_create_weekend_only_400(client):
    resp = client.post("/api/usage", json={"start": "2026-07-18", "end": "2026-07-19"})
    assert resp.status_code == 400
    assert not _all_entries()


def _create_one(client, day="2026-07-13", type="pto") -> int:
    resp = client.post("/api/usage", json={"start": day, "end": day, "type": type})
    return resp.json()["created"][0]["id"]


def test_usage_patch_requested_toggle(client):
    entry_id = _create_one(client)
    resp = client.patch(f"/api/usage/{entry_id}", json={"requested": True})
    assert resp.status_code == 200
    assert resp.json()["row"]["requested"] is True
    assert _all_entries()[0].requested is True

    resp = client.patch(f"/api/usage/{entry_id}", json={"requested": False})
    assert resp.json()["row"]["requested"] is False


def test_usage_patch_edit(client):
    entry_id = _create_one(client)
    resp = client.patch(
        f"/api/usage/{entry_id}",
        json={
            "date": "2026-07-20",
            "hours": 4,
            "type": "personal_holiday",
            "reason": "half day",
        },
    )
    assert resp.status_code == 200
    row = resp.json()["row"]
    assert row["date"] == "2026-07-20"
    assert row["hours"] == 4.0
    assert row["type"] == "personal_holiday"
    assert row["reason"] == "half day"


def test_usage_delete_204(client):
    entry_id = _create_one(client)
    resp = client.delete(f"/api/usage/{entry_id}")
    assert resp.status_code == 204
    assert not _all_entries()


def test_usage_list_filters(client):
    client.post("/api/usage", json={"start": "2026-07-13", "end": "2026-07-13", "type": "pto"})
    client.post(
        "/api/usage",
        json={"start": "2026-07-14", "end": "2026-07-14", "type": "personal_holiday"},
    )
    ph = client.get("/api/usage", params={"type": "personal_holiday"}).json()
    assert [r["date"] for r in ph["rows"]] == ["2026-07-14"]

    none = client.get("/api/usage", params={"year": 2099}).json()
    assert none["rows"] == []


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


def test_projection_known_value(client):
    """One 8 h PTO day on 2026-03-03 → balance 333.55 on 2026-07-08 (period 92)."""
    with get_session() as session:
        session.add(UsageEntry(date=date(2026, 3, 3), hours=8, type=UsageType.pto))
        session.commit()

    data = client.get("/api/projection", params={"date": "2026-07-08"}).json()
    assert data["snap"]["pto_balance"] == 333.55
    assert data["snap"]["period"] == 92
    assert data["period_start"] == "2026-07-06"
    assert data["period_end"] == "2026-07-19"
    assert data["target"] == "2026-07-08"


def test_projection_default_date_is_today(client):
    data = client.get("/api/projection").json()
    assert data["target"] == date.today().isoformat()
    assert data["today"] == date.today().isoformat()


def test_projection_malformed_date_400(client):
    resp = client.get("/api/projection", params={"date": "not-a-date"})
    assert resp.status_code == 400
    assert "error" in resp.json()["detail"]


def test_projection_pre_hire_date_400(client):
    resp = client.get("/api/projection", params={"date": "2022-12-25"})
    assert resp.status_code == 400
    assert "precedes the hire date" in resp.json()["detail"]["error"]


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


def test_settings_get_shape(client):
    data = client.get("/api/settings").json()
    assert set(data.keys()) == {"constants", "fields", "holidays", "tiers"}
    assert data["constants"]["max_balance_hours"] == "360"
    assert {"key", "kind", "label", "help"} == set(data["fields"][0].keys())
    assert {"id", "date", "name"} == set(data["holidays"][0].keys())
    tier = data["tiers"][0]
    assert set(tier.keys()) == {"id", "starts_on", "annual_days", "annual_hours", "label"}


def test_settings_put_valid(client):
    body = dict(DEFAULT_SETTINGS)
    body["rollover_hours"] = "250"
    resp = client.put("/api/settings", json=body)
    assert resp.status_code == 200
    assert resp.json() == {"saved": True}
    assert client.get("/api/settings").json()["constants"]["rollover_hours"] == "250"


def test_settings_put_invalid(client):
    body = dict(DEFAULT_SETTINGS)
    body["max_balance_hours"] = "-5"
    body["hire_date"] = "not-a-date"
    resp = client.put("/api/settings", json=body)
    assert resp.status_code == 400
    errors = resp.json()["errors"]
    assert any("greater than 0" in e for e in errors)
    assert any("not a valid date" in e for e in errors)
    # Nothing persisted.
    assert client.get("/api/settings").json()["constants"]["max_balance_hours"] == "360"


def test_settings_holiday_add_and_delete(client):
    resp = client.post("/api/settings/holidays", json={"date": "2026-08-12", "name": "Test Day"})
    assert resp.status_code == 200
    holidays = resp.json()["holidays"]
    match = [h for h in holidays if h["date"] == "2026-08-12"]
    assert match and match[0]["name"] == "Test Day"
    holiday_id = match[0]["id"]

    resp = client.delete(f"/api/settings/holidays/{holiday_id}")
    assert resp.status_code == 200
    assert all(h["date"] != "2026-08-12" for h in resp.json()["holidays"])


def test_settings_tier_add_edit_delete(client):
    resp = client.post(
        "/api/settings/tiers",
        json={
            "starts_on": "2038-01-09",
            "annual_days": 37,
            "annual_hours": 296,
            "label": "37 days/yr",
        },
    )
    assert resp.status_code == 200
    tiers = resp.json()["tiers"]
    assert len(tiers) == 4
    new_id = [t for t in tiers if t["starts_on"] == "2038-01-09"][0]["id"]

    resp = client.put(
        f"/api/settings/tiers/{new_id}",
        json={
            "starts_on": "2038-01-09",
            "annual_days": 40,
            "annual_hours": 320,
            "label": "40 days/yr",
        },
    )
    assert [t for t in resp.json()["tiers"] if t["id"] == new_id][0]["annual_hours"] == 320.0

    resp = client.delete(f"/api/settings/tiers/{new_id}")
    assert len(resp.json()["tiers"]) == 3


def test_settings_last_tier_delete_guarded(client):
    with get_session() as session:
        ids = [
            t.id
            for t in session.exec(select(AccrualTier).order_by(AccrualTier.starts_on)).all()
        ]
    for tier_id in ids[:-1]:
        assert client.delete(f"/api/settings/tiers/{tier_id}").status_code == 200
    resp = client.delete(f"/api/settings/tiers/{ids[-1]}")
    assert resp.status_code == 400


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #

_CSV = (
    "Date,Hours,Type,Reason,Requested\n"
    "2026-03-02,8,PTO,,No\n"
    "2026-03-03,8,Personal Holiday,,Yes\n"
)


def test_import_preview(client):
    csv_text = _CSV + "bad-date,8,PTO,,No\n"
    resp = client.post(
        "/api/import/preview",
        files={"file": ("usage.csv", csv_text, "text/csv")},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2  # two valid rows; the bad-date row is an error
    assert any("bad-date" in e for e in data["errors"])
    assert data["sample"][0]["date"] == "2026-03-02"
    assert data["sample"][1]["type"] == "personal_holiday"


def test_import_confirm_replace_then_merge(client):
    # Seed a pre-existing row that a replace must wipe.
    with get_session() as session:
        session.add(UsageEntry(date=date(2026, 1, 5), hours=8, type=UsageType.pto))
        session.commit()

    resp = client.post("/api/import/confirm", json={"csv_text": _CSV, "mode": "replace"})
    assert resp.status_code == 200
    assert resp.json() == {"imported": 2, "skipped": 0, "mode": "replace"}
    assert len(_all_entries()) == 2  # the seeded 2026-01-05 row was replaced

    # Re-importing the same rows in merge mode skips both duplicates.
    resp = client.post("/api/import/confirm", json={"csv_text": _CSV, "mode": "merge"})
    assert resp.json() == {"imported": 0, "skipped": 2, "mode": "merge"}
    assert len(_all_entries()) == 2
