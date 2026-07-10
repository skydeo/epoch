"""CSV import/export — parsing, 0-hour skip, replace idempotency, round-trip."""

from __future__ import annotations

from datetime import date

from sqlmodel import select

from epoch.csv_io import parse_usage_csv, render_usage_csv
from epoch.db import get_session
from epoch.models import UsageEntry, UsageType

# A small sheet-shaped export: mixed date formats, a PH row, Yes/No requested,
# and a 0-hour weekend padding row that must be skipped.
SAMPLE_CSV = (
    "Date,Hours,Type,Reason,Requested\n"
    "7/13/2026,8,PTO,Vacation,Yes\n"
    "2026-07-14,8,PTO,Vacation,No\n"
    "7/15/2026,8,Personal Holiday,Birthday,TRUE\n"
    "7/18/2026,0,PTO,weekend pad,No\n"
)


def _all_entries():
    with get_session() as session:
        return list(session.exec(select(UsageEntry).order_by(UsageEntry.date)).all())


# --------------------------------------------------------------------------- #
# Pure parsing
# --------------------------------------------------------------------------- #


def test_parse_sheet_format():
    result = parse_usage_csv(SAMPLE_CSV)
    assert not result.errors
    assert len(result.rows) == 3  # the 0-hour row is skipped

    by_date = {row.date: row for row in result.rows}
    assert by_date[date(2026, 7, 13)].hours == 8.0
    assert by_date[date(2026, 7, 13)].requested is True
    assert by_date[date(2026, 7, 14)].requested is False
    assert by_date[date(2026, 7, 15)].type == UsageType.personal_holiday


def test_parse_collects_row_errors():
    bad = "Date,Hours,Type,Reason,Requested\nnot-a-date,8,PTO,,Yes\n2026-07-14,x,PTO,,No\n"
    result = parse_usage_csv(bad)
    assert len(result.rows) == 0
    assert len(result.errors) == 2
    assert result.errors[0].row == 2  # header is row 1


def test_zero_hour_rows_skipped():
    result = parse_usage_csv(
        "Date,Hours,Type,Reason,Requested\n2026-07-18,0,PTO,,No\n"
    )
    assert result.rows == []
    assert result.errors == []


# --------------------------------------------------------------------------- #
# Import (preview → confirm over the JSON API) and export
# --------------------------------------------------------------------------- #


def _import(client, text, mode="replace"):
    preview = client.post(
        "/api/import/preview", files={"file": ("usage.csv", text, "text/csv")}
    )
    assert preview.status_code == 200
    confirm = client.post(
        "/api/import/confirm", json={"csv_text": text, "mode": mode}
    )
    assert confirm.status_code == 200
    return confirm


def test_replace_mode_idempotent(client):
    _import(client, SAMPLE_CSV)
    assert len(_all_entries()) == 3
    _import(client, SAMPLE_CSV)  # re-run
    assert len(_all_entries()) == 3  # not duplicated


def test_merge_skips_duplicates(client):
    _import(client, SAMPLE_CSV, mode="replace")
    assert len(_all_entries()) == 3
    resp = _import(client, SAMPLE_CSV, mode="merge")  # same rows again
    assert resp.json() == {"imported": 0, "skipped": 3, "mode": "merge"}
    assert len(_all_entries()) == 3  # (date, type, hours) dedup


def test_export_round_trips(client):
    _import(client, SAMPLE_CSV)
    export = client.get("/export/csv")
    assert export.status_code == 200
    assert export.headers["content-type"].startswith("text/csv")

    # Re-parse the export and compare to what's in the DB.
    reparsed = parse_usage_csv(export.text)
    entries = _all_entries()
    assert len(reparsed.rows) == len(entries) == 3
    got = {(r.date, r.type, r.hours) for r in reparsed.rows}
    want = {(e.date, e.type, e.hours) for e in entries}
    assert got == want


def test_render_round_trips_pure():
    entries = [
        UsageEntry(date=date(2026, 7, 13), hours=8.0, type=UsageType.pto,
                   reason="Vacation", requested=True),
        UsageEntry(date=date(2026, 7, 15), hours=4.0,
                   type=UsageType.personal_holiday, reason=None, requested=False),
    ]
    text = render_usage_csv(entries)
    result = parse_usage_csv(text)
    assert not result.errors
    assert len(result.rows) == 2
    assert result.rows[0].type == UsageType.pto
    assert result.rows[0].requested is True
    assert result.rows[1].type == UsageType.personal_holiday
    assert result.rows[1].hours == 4.0
