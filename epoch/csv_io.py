"""CSV import/export for the usage log.

The user's source-of-truth today is a Google Sheet; import lets him seed epoch
from an export and export gives him a backup in the same shape. Columns::

    Date, Hours, Type, Reason, Requested

Parsing is lenient (the sheet is hand-maintained) and matches the stdlib
``_parse_golden_csv`` helper in ``tests/test_engine.py`` so the golden
acceptance test stays valid: it accepts both ISO (``YYYY-MM-DD``) and
``M/D/YYYY`` dates, maps any type containing "personal" to a personal holiday
(else PTO), reads ``Requested`` as Yes/No/TRUE/FALSE, and **skips rows whose
Hours is 0** (the sheet pads date ranges with 0-hour weekend rows). Per-row
problems are collected as ``ParseError`` (row number + message) rather than
failing the whole file.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field
from datetime import date

from epoch.models import UsageType

CSV_HEADER = ["Date", "Hours", "Type", "Reason", "Requested"]

_TRUE_TOKENS = {"yes", "y", "true", "1", "t"}


@dataclass(frozen=True, slots=True)
class ParsedRow:
    """One accepted usage row, ready to become a ``UsageEntry``."""

    date: date
    hours: float
    type: UsageType
    reason: str | None
    requested: bool


@dataclass(frozen=True, slots=True)
class ParseError:
    """A per-row validation failure — 1-based row number plus a message."""

    row: int
    message: str


@dataclass(frozen=True, slots=True)
class ParseResult:
    """Outcome of ``parse_usage_csv``: accepted rows and per-row errors."""

    rows: list[ParsedRow] = field(default_factory=list)
    errors: list[ParseError] = field(default_factory=list)


def _parse_date(value: str) -> date:
    """Accept ISO ``YYYY-MM-DD`` or ``M/D/YYYY`` (matches the golden parser)."""
    try:
        return date.fromisoformat(value)
    except ValueError:
        month, day, year = (int(part) for part in value.split("/"))
        return date(year, month, day)


def _parse_bool(value: str) -> bool:
    return value.strip().lower() in _TRUE_TOKENS


def _map_type(value: str) -> UsageType:
    return (
        UsageType.personal_holiday
        if "personal" in value.lower()
        else UsageType.pto
    )


def parse_usage_csv(text: str) -> ParseResult:
    """Parse the usage CSV ``text`` into accepted rows + collected errors.

    Header row is row 1; data rows are numbered from 2 (spreadsheet-style) in
    any error. 0-hour rows are silently skipped. A row with an unparseable date
    or hours is recorded as an error and dropped, not fatal.
    """
    result = ParseResult()
    reader = csv.DictReader(io.StringIO(text))
    for lineno, raw in enumerate(reader, start=2):
        norm = {
            (k or "").strip().lower(): (v or "").strip() for k, v in raw.items()
        }

        raw_hours = norm.get("hours", "")
        try:
            hours = float(raw_hours) if raw_hours else 0.0
        except ValueError:
            result.errors.append(
                ParseError(lineno, f"invalid hours {raw_hours!r}")
            )
            continue
        if hours == 0:
            continue  # weekend/holiday padding rows are not usage

        raw_date = norm.get("date", "")
        try:
            parsed_date = _parse_date(raw_date)
        except (ValueError, KeyError):
            result.errors.append(
                ParseError(lineno, f"invalid date {raw_date!r}")
            )
            continue

        result.rows.append(
            ParsedRow(
                date=parsed_date,
                hours=hours,
                type=_map_type(norm.get("type", "")),
                reason=norm.get("reason") or None,
                requested=_parse_bool(norm.get("requested", "")),
            )
        )
    return result


def _type_label(value: UsageType | str) -> str:
    raw = value.value if isinstance(value, UsageType) else str(value)
    return "Personal Holiday" if raw == UsageType.personal_holiday.value else "PTO"


def render_usage_csv(entries) -> str:
    """Render usage ``entries`` to CSV text in the canonical column format.

    Round-trips with ``parse_usage_csv``: dates as ISO, type as
    "PTO"/"Personal Holiday", requested as Yes/No. ``entries`` is any iterable of
    objects exposing ``date``, ``hours``, ``type``, ``reason``, ``requested``.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_HEADER)
    for entry in entries:
        writer.writerow(
            [
                entry.date.isoformat(),
                _format_hours(entry.hours),
                _type_label(entry.type),
                entry.reason or "",
                "Yes" if entry.requested else "No",
            ]
        )
    return buffer.getvalue()


def _format_hours(hours: float) -> str:
    """Whole hours render without a trailing ``.0`` (``8`` not ``8.0``)."""
    return str(int(hours)) if float(hours).is_integer() else str(hours)
