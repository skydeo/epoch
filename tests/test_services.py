"""Unit tests for the pure trip-grouping helper (``services.group_trips``).

No DB or client — these build ``UsageEntry`` rows directly and assert the
grouping folds them into the right "trips". The engine, models, and CSV import
are untouched by this feature; only the grouping/serialization is exercised.
"""

from __future__ import annotations

from datetime import date

from epoch.models import UsageEntry, UsageType
from epoch.services import group_trips


def _entry(day: str, *, id: int, reason=None, type=UsageType.pto, hours=8.0, requested=False):
    return UsageEntry(
        id=id,
        date=date.fromisoformat(day),
        hours=hours,
        type=type,
        reason=reason,
        requested=requested,
    )


def test_empty_input():
    assert group_trips([], set()) == []


def test_weekend_bridge_is_one_trip():
    """Fri + the following Mon (weekend between) group into a single trip."""
    rows = [_entry("2026-07-17", id=1), _entry("2026-07-20", id=2)]  # Fri, Mon
    trips = group_trips(rows, set())
    assert len(trips) == 1
    trip = trips[0]
    assert trip["start"] == "2026-07-17"
    assert trip["end"] == "2026-07-20"
    assert trip["day_count"] == 2
    assert trip["total_hours"] == 16.0
    assert trip["ids"] == [1, 2]
    assert [d["date"] for d in trip["days"]] == ["2026-07-17", "2026-07-20"]


def test_company_holiday_bridge_is_one_trip():
    """A working-day gap that is a company holiday still bridges the trip."""
    # Tue 2026-07-14 and Thu 2026-07-16, with Wed 2026-07-15 a company holiday.
    rows = [_entry("2026-07-14", id=1), _entry("2026-07-16", id=2)]
    holidays = {date(2026, 7, 15)}
    trips = group_trips(rows, holidays)
    assert len(trips) == 1
    assert trips[0]["day_count"] == 2

    # Without the holiday, the real working day Wed splits them.
    assert len(group_trips(rows, set())) == 2


def test_working_day_gap_splits():
    """Mon and Wed with a plain working Tue in between are two trips."""
    rows = [_entry("2026-07-13", id=1), _entry("2026-07-15", id=2)]
    trips = group_trips(rows, set())
    assert len(trips) == 2
    assert [t["start"] for t in trips] == ["2026-07-13", "2026-07-15"]


def test_reason_mismatch_splits():
    rows = [
        _entry("2026-07-13", id=1, reason="Cruise"),
        _entry("2026-07-14", id=2, reason="Dentist"),
    ]
    trips = group_trips(rows, set())
    assert len(trips) == 2


def test_empty_reasons_group_together():
    """None and whitespace-only reasons compare equal and stay in one trip."""
    rows = [
        _entry("2026-07-13", id=1, reason=None),
        _entry("2026-07-14", id=2, reason="   "),
    ]
    trips = group_trips(rows, set())
    assert len(trips) == 1
    assert trips[0]["reason"] is None


def test_type_mismatch_splits():
    rows = [
        _entry("2026-07-13", id=1, type=UsageType.pto),
        _entry("2026-07-14", id=2, type=UsageType.personal_holiday),
    ]
    trips = group_trips(rows, set())
    assert len(trips) == 2


def test_same_date_entries_stay_in_one_trip():
    rows = [
        _entry("2026-07-13", id=1, hours=4.0, reason="Cruise"),
        _entry("2026-07-13", id=2, hours=4.0, reason="Cruise"),
    ]
    trips = group_trips(rows, set())
    assert len(trips) == 1
    assert trips[0]["day_count"] == 2
    assert trips[0]["total_hours"] == 8.0
    assert trips[0]["start"] == trips[0]["end"] == "2026-07-13"


def test_requested_tristate_all_some_none():
    all_rows = [
        _entry("2026-07-13", id=1, requested=True),
        _entry("2026-07-14", id=2, requested=True),
    ]
    some_rows = [
        _entry("2026-07-13", id=3, requested=True),
        _entry("2026-07-14", id=4, requested=False),
    ]
    none_rows = [
        _entry("2026-07-13", id=5, requested=False),
        _entry("2026-07-14", id=6, requested=False),
    ]
    assert group_trips(all_rows, set())[0]["requested"] == "all"
    assert group_trips(some_rows, set())[0]["requested"] == "some"
    assert group_trips(none_rows, set())[0]["requested"] == "none"


def test_multi_week_range_across_weekends_is_one_trip():
    """A three-week span of working days (weekends between) is a single trip."""
    from datetime import timedelta

    rows = []
    day = date(2026, 7, 6)  # Monday
    idx = 1
    while day <= date(2026, 7, 24):  # through Friday of week three
        if day.weekday() < 5:
            rows.append(_entry(day.isoformat(), id=idx, reason="Cruise"))
            idx += 1
        day += timedelta(days=1)
    trips = group_trips(rows, set())
    assert len(trips) == 1
    assert trips[0]["start"] == "2026-07-06"
    assert trips[0]["end"] == "2026-07-24"
    assert trips[0]["day_count"] == 15


def test_allocate_ph_first_splits_a_partial_day_and_resets_each_year(cfg):
    from epoch.engine import UsageItem
    from epoch.services import allocate_ph_first

    used = [UsageItem(date(2026, 3, 2), 12.0, is_ph=True)]  # 4 h PH left in 2026
    days = [date(2026, 12, 30), date(2026, 12, 31), date(2027, 1, 4)]
    out = allocate_ph_first(cfg, used, days)
    assert [(u.date, u.hours, u.is_ph) for u in out] == [
        (date(2026, 12, 30), 4.0, True),
        (date(2026, 12, 30), 4.0, False),
        (date(2026, 12, 31), 8.0, False),
        (date(2027, 1, 4), 8.0, True),  # fresh 2027 grant
    ]
