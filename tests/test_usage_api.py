"""Usage CRUD API — range expansion, filters, inline edit, toggle, delete."""

from __future__ import annotations

from datetime import date

from sqlmodel import select

from epoch.db import get_session
from epoch.models import CompanyHoliday, UsageEntry, UsageType


def _all_entries():
    with get_session() as session:
        return list(session.exec(select(UsageEntry).order_by(UsageEntry.date)).all())


def test_range_skips_weekend_and_holiday(client):
    """Mon–Sun with a Wednesday company holiday → 4 rows × 8h (Mon/Tue/Thu/Fri)."""
    # Seed a mid-week holiday inside the range.
    with get_session() as session:
        session.add(CompanyHoliday(date=date(2026, 7, 15), name="Test Holiday"))
        session.commit()

    resp = client.post(
        "/usage",
        data={"start": "2026-07-13", "end": "2026-07-19", "type": "pto"},
    )
    assert resp.status_code == 201

    entries = _all_entries()
    assert len(entries) == 4
    assert [e.date for e in entries] == [
        date(2026, 7, 13),  # Mon
        date(2026, 7, 14),  # Tue
        date(2026, 7, 16),  # Thu (15th is the holiday)
        date(2026, 7, 17),  # Fri
    ]
    assert all(e.hours == 8.0 for e in entries)
    assert all(e.type == UsageType.pto for e in entries)


def test_weekend_only_range_rejected(client):
    resp = client.post(
        "/usage",
        data={"start": "2026-07-18", "end": "2026-07-19"},  # Sat–Sun
    )
    assert resp.status_code == 400
    assert not _all_entries()


def test_pre_hire_range_rejected(client):
    resp = client.post(
        "/usage",
        data={"start": "2022-12-01", "end": "2022-12-02"},
    )
    assert resp.status_code == 400
    assert not _all_entries()


def test_personal_holiday_type(client):
    resp = client.post(
        "/usage",
        data={"start": "2026-07-13", "end": "2026-07-13", "type": "Personal Holiday"},
    )
    assert resp.status_code == 201
    entries = _all_entries()
    assert len(entries) == 1
    assert entries[0].type == UsageType.personal_holiday


def _create_one(client, day="2026-07-13", type="pto") -> int:
    client.post("/usage", data={"start": day, "end": day, "type": type})
    return _all_entries()[0].id


def test_toggle_requested(client):
    entry_id = _create_one(client)
    assert _all_entries()[0].requested is False

    resp = client.post(f"/usage/{entry_id}/requested")
    assert resp.status_code == 200
    assert _all_entries()[0].requested is True

    client.post(f"/usage/{entry_id}/requested")
    assert _all_entries()[0].requested is False


def test_edit_row(client):
    entry_id = _create_one(client)
    resp = client.post(
        f"/usage/{entry_id}",
        data={
            "date": "2026-07-20",
            "hours": "4",
            "type": "personal_holiday",
            "reason": "half day",
        },
    )
    assert resp.status_code == 200
    entry = _all_entries()[0]
    assert entry.date == date(2026, 7, 20)
    assert entry.hours == 4.0
    assert entry.type == UsageType.personal_holiday
    assert entry.reason == "half day"


def test_edit_form_renders(client):
    entry_id = _create_one(client)
    resp = client.get(f"/usage/{entry_id}/edit")
    assert resp.status_code == 200
    assert 'name="hours"' in resp.text


def test_delete_row(client):
    entry_id = _create_one(client)
    resp = client.delete(f"/usage/{entry_id}")
    assert resp.status_code == 200
    assert not _all_entries()


def test_rows_filter_by_type_and_year(client):
    client.post("/usage", data={"start": "2026-07-13", "end": "2026-07-13", "type": "pto"})
    client.post(
        "/usage",
        data={"start": "2026-07-14", "end": "2026-07-14", "type": "Personal Holiday"},
    )

    resp = client.get("/usage/rows", params={"type": "personal_holiday"})
    assert resp.status_code == 200
    assert "2026-07-14" in resp.text
    assert "2026-07-13" not in resp.text

    resp = client.get("/usage/rows", params={"year": 2026})
    assert "2026-07-13" in resp.text and "2026-07-14" in resp.text

    resp = client.get("/usage/rows", params={"year": 2099})
    assert "No usage entries" in resp.text
