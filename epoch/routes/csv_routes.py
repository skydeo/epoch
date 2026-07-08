"""CSV import (preview → confirm) and export.

Import is two-step so a destructive replace is never a surprise: ``POST
/import/csv`` parses the upload and returns a preview partial (row count, per-row
errors, mode choice) that carries the raw CSV text forward in a hidden field;
``POST /import/csv/confirm`` re-parses that text and applies it. The primary mode
is **replace-all** — truly idempotent and re-runnable — with
**merge-skip-duplicates** on ``(date, type, hours)`` as a non-destructive
alternative. ``GET /export/csv`` streams the current log in the same format for
backup / round-trip.
"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlmodel import select

from epoch.csv_io import parse_usage_csv, render_usage_csv
from epoch.db import get_session
from epoch.models import UsageEntry
from epoch.templating import templates

router = APIRouter(tags=["csv"])


@router.post("/import/csv")
async def import_preview(request: Request, file: UploadFile = File(...)) -> Response:
    """Parse an uploaded CSV and render the import preview partial."""
    raw = await file.read()
    text = raw.decode("utf-8-sig")
    result = parse_usage_csv(text)
    return templates.TemplateResponse(
        request,
        "_import_preview.html",
        {
            "count": len(result.rows),
            "errors": result.errors,
            "mode": "replace",
            "csv_text": text,
        },
    )


@router.post("/import/csv/confirm")
async def import_confirm(
    request: Request,
    csv_text: str = Form(...),
    mode: str = Form("replace"),
) -> Response:
    """Apply a previewed import in ``replace`` (default) or ``merge`` mode."""
    result = parse_usage_csv(csv_text)

    with get_session() as session:
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
        for parsed in result.rows:
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

    return templates.TemplateResponse(
        request,
        "_import_result.html",
        {"imported": imported, "mode": mode, "skipped": len(result.rows) - imported},
    )


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
