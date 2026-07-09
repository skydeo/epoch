"""JSON API for the single-page frontend (Phase 1 of the modernization).

Every endpoint here is a **thin serialization wrapper** over the same engine /
domain functions the server-rendered HTML routes already call — there is no new
business logic. The HTML/HTMX routes stay alive alongside this router until the
SPA is wired (a later phase deletes them).

Serialization conventions (see HANDOFF.md §6):

* dates are ISO strings (``YYYY-MM-DD``),
* ``UsageType`` is its ``.value`` (``"pto"`` / ``"personal_holiday"``),
* floats carry the same rounding the engine/templates already apply.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile, status
from fastapi.responses import JSONResponse
from sqlmodel import select

from epoch.csv_io import parse_usage_csv
from epoch.db import get_session
from epoch.domain import load_engine_config, load_usage
from epoch.engine import (
    BalanceSnapshot,
    PeriodRow,
    compute_ledger,
    period_index_for,
)
from epoch.models import UsageEntry, now_utc
from epoch.routes.csv_routes import apply_usage_import
from epoch.routes.pages import (
    _dashboard_stats,
    _horizon,
    _projection_snapshot,
    _row_state,
    _today,
    date_from_iso,
)
from epoch.routes.settings_ui import (
    SETTINGS_FIELDS,
    _create_holiday,
    _create_tier,
    _load_holidays,
    _load_settings,
    _load_tiers,
    _persist_settings,
    _remove_holiday,
    _remove_tier,
    _update_tier,
    _validate_settings,
)
from epoch.routes.usage import _get_entry, _usage_type, create_range_entries

router = APIRouter(prefix="/api", tags=["api"])


# --------------------------------------------------------------------------- #
# Serialization helpers
# --------------------------------------------------------------------------- #


def _usage_json(entry: UsageEntry) -> dict:
    """The canonical UsageEntry JSON shape consumed by the SPA."""
    return {
        "id": entry.id,
        "date": entry.date.isoformat(),
        "hours": entry.hours,
        "type": entry.type.value,
        "reason": entry.reason,
        "requested": entry.requested,
    }


def _period_json(row: PeriodRow, today: date, current_index: int) -> dict:
    """One accruals ledger row: engine fields + display state flags."""
    return {
        "index": row.index,
        "start": row.start.isoformat(),
        "end": row.end.isoformat(),
        "pay_date": row.pay_date.isoformat(),
        "accrual": row.accrual,
        "pto_used": row.pto_used,
        "ph_used": row.ph_used,
        "balance": row.balance,
        "lost_to_cap": row.lost_to_cap,
        "lost_to_rollover": row.lost_to_rollover,
        "state": _row_state(row, today).removeprefix("period-"),
        "is_current": row.index == current_index,
    }


def _snapshot_json(snap: BalanceSnapshot) -> dict:
    return {
        "as_of": snap.as_of.isoformat(),
        "period": snap.period,
        "pto_balance": snap.pto_balance,
        "ph_granted": snap.ph_granted,
        "ph_used": snap.ph_used,
        "ph_remaining": snap.ph_remaining,
        "warnings": list(snap.warnings),
    }


def _holiday_json(holiday) -> dict:
    return {"id": holiday.id, "date": holiday.date.isoformat(), "name": holiday.name}


def _tier_json(tier) -> dict:
    return {
        "id": tier.id,
        "starts_on": tier.starts_on.isoformat(),
        "annual_days": tier.annual_days,
        "annual_hours": tier.annual_hours,
        "label": tier.label,
    }


# --------------------------------------------------------------------------- #
# Dashboard
# --------------------------------------------------------------------------- #


@router.get("/dashboard")
async def dashboard() -> dict:
    """Stat-card payload — the JSON sibling of the dashboard page."""
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)
    stats = _dashboard_stats(cfg, usage, today)
    stats["next_pay_date"] = (
        stats["next_pay_date"].isoformat() if stats["next_pay_date"] else None
    )
    stats["warnings"] = list(stats["warnings"])
    return stats


# --------------------------------------------------------------------------- #
# Accruals
# --------------------------------------------------------------------------- #


@router.get("/accruals")
async def accruals(year: int | None = None) -> dict:
    """Folded ledger rows with past/current/future state and current highlight."""
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    ledger = compute_ledger(cfg, usage, today)
    current_index = period_index_for(cfg, today)
    view = [r for r in ledger if year is None or r.end.year == year]
    return {
        "rows": [_period_json(r, today, current_index) for r in view],
        "years": sorted({r.end.year for r in ledger}),
        "current_index": current_index,
    }


# --------------------------------------------------------------------------- #
# Usage
# --------------------------------------------------------------------------- #


@router.get("/usage")
async def usage_list(
    type: str | None = None,  # noqa: A002 - query field name
    year: int | None = None,
    requested: bool | None = None,
) -> dict:
    """Filtered usage log (by type / year / requested) plus form context."""
    with get_session() as session:
        cfg = load_engine_config(session)
        entries = list(session.exec(select(UsageEntry)).all())

    if type:
        wanted = _usage_type(type)
        entries = [e for e in entries if e.type == wanted]
    if year is not None:
        entries = [e for e in entries if e.date.year == year]
    if requested is not None:
        entries = [e for e in entries if e.requested == requested]

    entries.sort(key=lambda e: (e.date, e.id or 0))
    all_years = sorted({e.date.year for e in entries})
    return {
        "rows": [_usage_json(e) for e in entries],
        "years": all_years,
        "hire_date": cfg.hire_date.isoformat(),
        "hours_per_day": cfg.hours_per_day,
    }


@router.post("/usage", status_code=status.HTTP_201_CREATED)
async def usage_create(request: Request) -> dict:
    """Expand ``{start, end, type, reason, requested}`` into per-day rows."""
    body = await request.json()
    try:
        start_date = date.fromisoformat(body["start"])
        end_date = date.fromisoformat(body["end"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid start/end date: {exc}",
        ) from exc

    with get_session() as session:
        created = create_range_entries(
            session,
            start_date,
            end_date,
            _usage_type(body.get("type", "pto")),
            body.get("reason"),
            bool(body.get("requested", False)),
        )
        return {"created": [_usage_json(e) for e in created]}


@router.patch("/usage/{entry_id}")
async def usage_patch(entry_id: int, request: Request) -> dict:
    """Partial update — inline edit fields and/or the ``requested`` toggle."""
    body = await request.json()
    with get_session() as session:
        entry = _get_entry(session, entry_id)
        if "date" in body:
            try:
                entry.date = date.fromisoformat(body["date"])
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"invalid date {body['date']!r}",
                ) from exc
        if "hours" in body:
            entry.hours = float(body["hours"])
        if "type" in body:
            entry.type = _usage_type(body["type"])
        if "reason" in body:
            entry.reason = (body["reason"] or "").strip() or None
        if "requested" in body:
            entry.requested = bool(body["requested"])
        entry.updated_at = now_utc()
        session.add(entry)
        session.commit()
        session.refresh(entry)
        return {"row": _usage_json(entry)}


@router.delete("/usage/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def usage_delete(entry_id: int) -> Response:
    """Delete one usage entry."""
    with get_session() as session:
        entry = _get_entry(session, entry_id)
        session.delete(entry)
        session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------- #
# Projection
# --------------------------------------------------------------------------- #


@router.get("/projection")
async def projection(date: str | None = None) -> dict:  # noqa: A002 - query name
    """Balance snapshot for ``?date=`` (default today).

    400 ``{error}`` for an unparseable date or one before the hire date.
    """
    today = _today()
    with get_session() as session:
        cfg = load_engine_config(session)
        usage = load_usage(session)

    if date is None:
        target = today
    else:
        try:
            target = date_from_iso(date)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": f"{date!r} is not a valid date."},
            ) from None
        if target < cfg.hire_date:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": (
                        f"Date {target.isoformat()} precedes the hire date "
                        f"{cfg.hire_date.isoformat()} — no pay period exists."
                    )
                },
            )

    result = _projection_snapshot(cfg, usage, today, target)
    return {
        "snap": _snapshot_json(result["snap"]),
        "period_start": result["period_start"].isoformat(),
        "period_end": result["period_end"].isoformat(),
        "period_pay": result["period_pay"].isoformat(),
        "balance_negative": result["balance_negative"],
        "warnings": list(result["warnings"]),
        "target": result["target"].isoformat(),
        "today": result["today"].isoformat(),
        "is_future": result["is_future"],
    }


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #


@router.get("/settings")
async def settings_get() -> dict:
    """Engine constants, field metadata, company holidays, and accrual tiers."""
    with get_session() as session:
        return {
            "constants": _load_settings(session),
            "fields": [
                {"key": key, "kind": kind, "label": label, "help": help_}
                for key, kind, label, help_ in SETTINGS_FIELDS
            ],
            "holidays": [_holiday_json(h) for h in _load_holidays(session)],
            "tiers": [_tier_json(t) for t in _load_tiers(session)],
        }


@router.put("/settings")
async def settings_put(request: Request) -> JSONResponse:
    """Validate and persist the engine constants. 400 ``{errors}`` on failure."""
    body = await request.json()
    form: dict = {}
    for key, _kind, _label, _help in SETTINGS_FIELDS:
        if key in body:
            value = body[key]
            form[key] = value if isinstance(value, bool) else str(value)
    values, errors = _validate_settings(form)
    if errors:
        return JSONResponse(
            {"errors": errors}, status_code=status.HTTP_400_BAD_REQUEST
        )
    with get_session() as session:
        _persist_settings(session, values)
    return JSONResponse({"saved": True})


@router.post("/settings/holidays")
async def holiday_add(request: Request) -> dict:
    """Add a company holiday (idempotent on date) → the full holiday list."""
    body = await request.json()
    try:
        d = date.fromisoformat(body["date"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid holiday date: {exc}",
        ) from exc
    with get_session() as session:
        _create_holiday(session, d, body.get("name", ""))
        return {"holidays": [_holiday_json(h) for h in _load_holidays(session)]}


@router.delete("/settings/holidays/{holiday_id}")
async def holiday_delete(holiday_id: int) -> dict:
    """Delete a company holiday → the full holiday list."""
    with get_session() as session:
        _remove_holiday(session, holiday_id)
        return {"holidays": [_holiday_json(h) for h in _load_holidays(session)]}


@router.post("/settings/tiers")
async def tier_add(request: Request) -> dict:
    """Add an accrual tier (idempotent on start date) → the full tier list."""
    body = await request.json()
    try:
        d = date.fromisoformat(body["starts_on"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid tier start date: {exc}",
        ) from exc
    with get_session() as session:
        _create_tier(
            session,
            d,
            float(body["annual_days"]),
            float(body["annual_hours"]),
            body.get("label", ""),
        )
        return {"tiers": [_tier_json(t) for t in _load_tiers(session)]}


@router.put("/settings/tiers/{tier_id}")
async def tier_update(tier_id: int, request: Request) -> dict:
    """Edit an accrual tier in place → the full tier list."""
    body = await request.json()
    try:
        d = date.fromisoformat(body["starts_on"])
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid tier start date: {exc}",
        ) from exc
    with get_session() as session:
        _update_tier(
            session,
            tier_id,
            d,
            float(body["annual_days"]),
            float(body["annual_hours"]),
            body.get("label", ""),
        )
        return {"tiers": [_tier_json(t) for t in _load_tiers(session)]}


@router.delete("/settings/tiers/{tier_id}")
async def tier_delete(tier_id: int) -> dict:
    """Delete an accrual tier (never the last) → the full tier list. 400 on last."""
    with get_session() as session:
        _remove_tier(session, tier_id)
        return {"tiers": [_tier_json(t) for t in _load_tiers(session)]}


# --------------------------------------------------------------------------- #
# Import
# --------------------------------------------------------------------------- #


@router.post("/import/preview")
async def import_preview(file: UploadFile = File(...)) -> dict:
    """Parse an uploaded CSV → row count, per-row error strings, a small sample."""
    raw = await file.read()
    text = raw.decode("utf-8-sig")
    result = parse_usage_csv(text)
    return {
        "count": len(result.rows),
        "errors": [f"row {e.row}: {e.message}" for e in result.errors],
        "sample": [
            {
                "date": r.date.isoformat(),
                "hours": r.hours,
                "type": r.type.value,
                "reason": r.reason,
                "requested": r.requested,
            }
            for r in result.rows[:5]
        ],
    }


@router.post("/import/confirm")
async def import_confirm(request: Request) -> dict:
    """Apply a previewed import from ``{csv_text, mode}`` (``replace``|``merge``)."""
    body = await request.json()
    csv_text = body.get("csv_text", "")
    mode = body.get("mode", "replace")
    result = parse_usage_csv(csv_text)
    with get_session() as session:
        imported = apply_usage_import(session, result.rows, mode)
    return {
        "imported": imported,
        "skipped": len(result.rows) - imported,
        "mode": mode,
    }
