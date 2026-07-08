"""Usage CRUD (HTMX).

A usage *range* (start, end, type, reason, requested) is entered on the usage
page; ``domain.expand_range`` turns it into one per-day row per working day, at
``hours_per_day`` each (editable afterwards). Weekend/holiday-only ranges and
pre-hire ranges are rejected with a 400. The rest are per-row operations that
swap a single ``<tr>`` partial back into the table: filter, inline edit, toggle
the "requested" flag, delete.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Form, HTTPException, Request, Response, status
from sqlmodel import select

from epoch.db import get_session
from epoch.domain import expand_range, load_engine_config
from epoch.models import CompanyHoliday, UsageEntry, UsageType, now_utc
from epoch.templating import templates

router = APIRouter(tags=["usage"])


def _usage_type(value: str) -> UsageType:
    """Map a form ``type`` value to a ``UsageType`` (default PTO)."""
    return (
        UsageType.personal_holiday
        if "personal" in (value or "").lower()
        else UsageType.pto
    )


def _parse_date(value: str, field: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid {field} date {value!r}",
        ) from exc


@router.post("/usage")
async def create_usage(
    request: Request,
    start: str = Form(...),
    end: str = Form(...),
    type: str = Form("pto"),
    reason: str | None = Form(None),
    requested: bool = Form(False),
) -> Response:
    """Expand a range into per-day usage rows at ``hours_per_day`` each.

    400 if the range starts before the hire date or expands to zero working
    days (weekend/holiday-only).
    """
    start_date = _parse_date(start, "start")
    end_date = _parse_date(end, "end")

    with get_session() as session:
        cfg = load_engine_config(session)
        if start_date < cfg.hire_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"start date {start_date.isoformat()} precedes hire date "
                    f"{cfg.hire_date.isoformat()}"
                ),
            )
        holidays = {h.date for h in session.exec(select(CompanyHoliday)).all()}
        days = expand_range(start_date, end_date, holidays)
        if not days:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="range contains no working days (weekends/holidays only)",
            )

        usage_type = _usage_type(type)
        cleaned_reason = (reason or "").strip() or None
        created: list[UsageEntry] = []
        for day in days:
            entry = UsageEntry(
                date=day,
                hours=cfg.hours_per_day,
                type=usage_type,
                reason=cleaned_reason,
                requested=requested,
            )
            session.add(entry)
            created.append(entry)
        session.commit()
        for entry in created:
            session.refresh(entry)

        return templates.TemplateResponse(
            request,
            "_usage_rows.html",
            {"rows": created},
            status_code=status.HTTP_201_CREATED,
        )


@router.get("/usage/rows")
async def usage_rows(
    request: Request,
    type: str | None = None,
    year: int | None = None,
    requested: bool | None = None,
) -> Response:
    """Filtered usage rows (tbody re-render) by type / year / requested."""
    with get_session() as session:
        entries = list(session.exec(select(UsageEntry)).all())

    if type:
        wanted = _usage_type(type)
        entries = [entry for entry in entries if entry.type == wanted]
    if year is not None:
        entries = [entry for entry in entries if entry.date.year == year]
    if requested is not None:
        entries = [entry for entry in entries if entry.requested == requested]

    entries.sort(key=lambda entry: (entry.date, entry.id or 0))
    return templates.TemplateResponse(request, "_usage_rows.html", {"rows": entries})


def _get_entry(session, entry_id: int) -> UsageEntry:
    entry = session.get(UsageEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"usage entry {entry_id} not found",
        )
    return entry


@router.get("/usage/{entry_id}/edit")
async def edit_usage(request: Request, entry_id: int) -> Response:
    """Return the inline-edit form row for one entry."""
    with get_session() as session:
        entry = _get_entry(session, entry_id)
        return templates.TemplateResponse(
            request, "_usage_edit_row.html", {"row": entry}
        )


@router.post("/usage/{entry_id}")
async def update_usage(
    request: Request,
    entry_id: int,
    date: str = Form(...),  # noqa: A002 - form field name
    hours: float = Form(...),
    type: str = Form("pto"),
    reason: str | None = Form(None),
) -> Response:
    """Persist an inline edit and swap the display row back in."""
    new_date = _parse_date(date, "date")
    with get_session() as session:
        entry = _get_entry(session, entry_id)
        entry.date = new_date
        entry.hours = hours
        entry.type = _usage_type(type)
        entry.reason = (reason or "").strip() or None
        entry.updated_at = now_utc()
        session.add(entry)
        session.commit()
        session.refresh(entry)
        return templates.TemplateResponse(request, "_usage_row.html", {"row": entry})


@router.post("/usage/{entry_id}/requested")
async def toggle_requested(request: Request, entry_id: int) -> Response:
    """Flip the "entered in the HR system" flag and re-render the row."""
    with get_session() as session:
        entry = _get_entry(session, entry_id)
        entry.requested = not entry.requested
        entry.updated_at = now_utc()
        session.add(entry)
        session.commit()
        session.refresh(entry)
        return templates.TemplateResponse(request, "_usage_row.html", {"row": entry})


@router.delete("/usage/{entry_id}")
async def delete_usage(entry_id: int) -> Response:
    """Delete an entry. Returns empty body for ``hx-swap="delete"``."""
    with get_session() as session:
        entry = _get_entry(session, entry_id)
        session.delete(entry)
        session.commit()
    return Response(status_code=status.HTTP_200_OK)
