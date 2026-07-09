"""Settings page: engine constants, company holidays, accrual tiers.

The constants form is a plain (non-HTMX) POST that validates every field
server-side, saves the ``AppSetting`` rows, and 303-redirects back to
``GET /settings?saved=1`` so a refresh never re-submits. Holidays and tiers are
edited inline via HTMX, each mutation re-rendering just its ``<tbody>`` partial
(``_holiday_rows.html`` / ``_tier_rows.html``). The tier list is guarded so the
last remaining tier can never be deleted — the engine needs at least one rate.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Form, HTTPException, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlmodel import select

from epoch.db import get_session
from epoch.models import AccrualTier, AppSetting, CompanyHoliday
from epoch.templating import templates

router = APIRouter(tags=["settings"])

# Each engine constant with its input kind, label, and help text. The kind
# drives both the rendered <input> type and the server-side validation.
#   (key, kind, label, help)
SETTINGS_FIELDS: list[tuple[str, str, str, str]] = [
    ("hire_date", "date", "Hire date", "Anchors every pay period (a Monday)."),
    ("period_length_days", "int", "Period length (days)", "14 for biweekly."),
    ("pay_date_offset_days", "int", "Pay-date offset (days)", "Days after period end that pay lands."),
    ("periods_per_year", "int", "Periods per year", "26 for biweekly; divides the annual rate."),
    ("hours_per_day", "float", "Hours per day", "Default hours for one usage day."),
    ("max_balance_hours", "float", "Max balance / cap (hours)", "Hard cap; accrual above it is forfeited."),
    ("rollover_hours", "float", "Year-end rollover cap (hours)", "Balance above this is forfeited at Jan 1."),
    ("ph_annual_hours", "float", "Personal-holiday hours / year", "Granted Jan 1, use-or-lose Dec 31."),
    ("projection_horizon_months", "int", "Projection horizon (months)", "How far the dashboard chart looks ahead."),
    ("round_period_accrual", "bool", "Round per-period accrual", "Round the rate to 2dp (matches the sheet)."),
]


def _load_settings(session) -> dict[str, str]:
    return {row.key: row.value for row in session.exec(select(AppSetting)).all()}


def _load_holidays(session) -> list[CompanyHoliday]:
    return list(
        session.exec(select(CompanyHoliday).order_by(CompanyHoliday.date)).all()
    )


def _load_tiers(session) -> list[AccrualTier]:
    return list(
        session.exec(select(AccrualTier).order_by(AccrualTier.starts_on)).all()
    )


def _persist_settings(session, values: dict[str, str]) -> None:
    """Upsert every validated constant. Shared by the form route and the API."""
    for key, value in values.items():
        row = session.get(AppSetting, key)
        if row is None:
            session.add(AppSetting(key=key, value=value))
        else:
            row.value = value
            session.add(row)
    session.commit()


# --------------------------------------------------------------------------- #
# Constants form
# --------------------------------------------------------------------------- #


@router.get("/settings", response_class=Response)
async def settings_page(request: Request, saved: bool = False) -> Response:
    """Render the settings page: constants form + holiday and tier editors."""
    with get_session() as session:
        settings = _load_settings(session)
        holidays = _load_holidays(session)
        tiers = _load_tiers(session)
    return templates.TemplateResponse(
        request,
        "settings.html",
        {
            "active_page": "settings",
            "fields": SETTINGS_FIELDS,
            "settings": settings,
            "holidays": holidays,
            "tiers": tiers,
            "saved": saved,
            "errors": [],
        },
    )


def _validate_settings(form) -> tuple[dict[str, str], list[str]]:
    """Validate every constant; return (values-to-save, error messages)."""
    values: dict[str, str] = {}
    errors: list[str] = []
    for key, kind, label, _help in SETTINGS_FIELDS:
        if kind == "bool":
            values[key] = "true" if form.get(key) else "false"
            continue
        raw = (form.get(key) or "").strip()
        if kind == "date":
            try:
                date.fromisoformat(raw)
                values[key] = raw
            except ValueError:
                errors.append(f"{label}: not a valid date (YYYY-MM-DD).")
        elif kind == "int":
            try:
                n = int(raw)
            except ValueError:
                errors.append(f"{label}: must be a whole number.")
            else:
                if n <= 0:
                    errors.append(f"{label}: must be greater than 0.")
                else:
                    values[key] = str(n)
        else:  # float
            try:
                x = float(raw)
            except ValueError:
                errors.append(f"{label}: must be a number.")
            else:
                if x <= 0:
                    errors.append(f"{label}: must be greater than 0.")
                else:
                    values[key] = raw
    return values, errors


@router.post("/settings")
async def save_settings(request: Request) -> Response:
    """Validate and persist the constants, then 303 back with a saved flag."""
    form = await request.form()
    values, errors = _validate_settings(form)

    if errors:
        # Re-render with the user's submitted values and the error list.
        display: dict[str, str] = {}
        for key, kind, _label, _help in SETTINGS_FIELDS:
            if kind == "bool":
                display[key] = "true" if form.get(key) else "false"
            else:
                display[key] = (form.get(key) or "").strip()
        with get_session() as session:
            holidays = _load_holidays(session)
            tiers = _load_tiers(session)
        return templates.TemplateResponse(
            request,
            "settings.html",
            {
                "active_page": "settings",
                "fields": SETTINGS_FIELDS,
                "settings": display,
                "holidays": holidays,
                "tiers": tiers,
                "saved": False,
                "errors": errors,
            },
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    with get_session() as session:
        _persist_settings(session, values)

    return RedirectResponse("/settings?saved=1", status_code=status.HTTP_303_SEE_OTHER)


# --------------------------------------------------------------------------- #
# Company holidays (HTMX)
# --------------------------------------------------------------------------- #


def _parse_date_field(value: str, label: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"invalid {label} date {value!r}",
        ) from exc


def _holiday_rows(request: Request, session) -> Response:
    return templates.TemplateResponse(
        request, "_holiday_rows.html", {"holidays": _load_holidays(session)}
    )


def _create_holiday(session, d: date, name: str) -> None:
    """Idempotent-on-date insert of a company holiday. Shared by route + API."""
    exists = session.exec(
        select(CompanyHoliday).where(CompanyHoliday.date == d)
    ).first()
    if exists is None:
        session.add(CompanyHoliday(date=d, name=name.strip() or d.isoformat()))
        session.commit()


def _remove_holiday(session, holiday_id: int) -> None:
    holiday = session.get(CompanyHoliday, holiday_id)
    if holiday is not None:
        session.delete(holiday)
        session.commit()


@router.post("/settings/holidays")
async def add_holiday(
    request: Request,
    on: str = Form(..., alias="date"),
    name: str = Form(...),
) -> Response:
    """Add a company holiday (idempotent on date) and re-render the rows."""
    d = _parse_date_field(on, "holiday")
    with get_session() as session:
        _create_holiday(session, d, name)
        return _holiday_rows(request, session)


@router.delete("/settings/holidays/{holiday_id}")
async def delete_holiday(request: Request, holiday_id: int) -> Response:
    """Delete a company holiday and re-render the rows."""
    with get_session() as session:
        _remove_holiday(session, holiday_id)
        return _holiday_rows(request, session)


# --------------------------------------------------------------------------- #
# Accrual tiers (HTMX)
# --------------------------------------------------------------------------- #


def _tier_rows(request: Request, session) -> Response:
    return templates.TemplateResponse(
        request, "_tier_rows.html", {"tiers": _load_tiers(session)}
    )


def _create_tier(
    session, d: date, annual_days: float, annual_hours: float, label: str
) -> None:
    """Idempotent-on-start-date insert of an accrual tier. Shared by route + API."""
    exists = session.exec(
        select(AccrualTier).where(AccrualTier.starts_on == d)
    ).first()
    if exists is None:
        session.add(
            AccrualTier(
                starts_on=d,
                annual_days=annual_days,
                annual_hours=annual_hours,
                label=label.strip() or d.isoformat(),
            )
        )
        session.commit()


def _update_tier(
    session,
    tier_id: int,
    d: date,
    annual_days: float,
    annual_hours: float,
    label: str,
) -> None:
    tier = session.get(AccrualTier, tier_id)
    if tier is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"tier {tier_id} not found",
        )
    tier.starts_on = d
    tier.annual_days = annual_days
    tier.annual_hours = annual_hours
    tier.label = label.strip() or d.isoformat()
    session.add(tier)
    session.commit()


def _remove_tier(session, tier_id: int) -> None:
    """Delete a tier, guarding the last one (the engine needs at least a rate)."""
    if len(_load_tiers(session)) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="at least one accrual tier must remain",
        )
    tier = session.get(AccrualTier, tier_id)
    if tier is not None:
        session.delete(tier)
        session.commit()


@router.post("/settings/tiers")
async def add_tier(
    request: Request,
    starts_on: str = Form(...),
    annual_days: float = Form(...),
    annual_hours: float = Form(...),
    label: str = Form(...),
) -> Response:
    """Add an accrual tier (idempotent on start date) and re-render the rows."""
    d = _parse_date_field(starts_on, "tier start")
    with get_session() as session:
        _create_tier(session, d, annual_days, annual_hours, label)
        return _tier_rows(request, session)


@router.post("/settings/tiers/{tier_id}")
async def edit_tier(
    request: Request,
    tier_id: int,
    starts_on: str = Form(...),
    annual_days: float = Form(...),
    annual_hours: float = Form(...),
    label: str = Form(...),
) -> Response:
    """Edit an accrual tier in place and re-render the rows."""
    d = _parse_date_field(starts_on, "tier start")
    with get_session() as session:
        _update_tier(session, tier_id, d, annual_days, annual_hours, label)
        return _tier_rows(request, session)


@router.delete("/settings/tiers/{tier_id}")
async def delete_tier(request: Request, tier_id: int) -> Response:
    """Delete an accrual tier — but never the last one (engine needs a rate)."""
    with get_session() as session:
        _remove_tier(session, tier_id)
        return _tier_rows(request, session)
