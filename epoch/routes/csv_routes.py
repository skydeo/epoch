"""CSV export route + the shared import-apply helper.

The SPA's import flow is preview → confirm over the JSON API
(``/api/import/preview`` / ``/api/import/confirm`` in ``routes/api.py``);
``apply_usage_import`` here is the shared apply step. The primary mode is
**replace-all** — truly idempotent and re-runnable — with
**merge-skip-duplicates** on ``(date, type, hours)`` as a non-destructive
alternative. ``GET /export/csv`` streams the current log in the same format for
backup / round-trip.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from sqlmodel import select

from epoch.csv_io import render_usage_csv
from epoch.db import get_session
from epoch.models import UsageEntry

router = APIRouter(tags=["csv"])


def apply_usage_import(session, rows, mode: str) -> int:
    """Apply parsed usage ``rows`` in ``replace`` (default) or ``merge`` mode.

    Returns the number of rows actually inserted. ``replace`` wipes the log
    first; ``merge`` skips duplicates on ``(date, type, hours)``.
    """
    if mode == "replace":
        for existing in session.exec(select(UsageEntry)).all():
            session.delete(existing)
        session.commit()
        seen: set[tuple] = set()
    else:  # merge: skip duplicates on (date, type, hours)
        seen = {
            (entry.date, entry.type, entry.hours)
            for entry in session.exec(select(UsageEntry)).all()
        }

    imported = 0
    for parsed in rows:
        key = (parsed.date, parsed.type, parsed.hours)
        if key in seen:
            continue
        seen.add(key)
        session.add(
            UsageEntry(
                date=parsed.date,
                hours=parsed.hours,
                type=parsed.type,
                reason=parsed.reason,
                requested=parsed.requested,
            )
        )
        imported += 1
    session.commit()
    return imported


@router.get("/export/csv")
async def export_csv() -> StreamingResponse:
    """Stream the whole usage log as CSV (backup)."""
    with get_session() as session:
        entries = list(
            session.exec(select(UsageEntry).order_by(UsageEntry.date)).all()
        )
    text = render_usage_csv(entries)
    return StreamingResponse(
        iter([text]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="usage_export.csv"'},
    )
