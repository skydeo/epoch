"""Pure accrual engine — the heart of epoch.

Stdlib only (``datetime`` + ``dataclasses``); this module imports **nothing**
from ``epoch.*`` so it stays trivially testable and reusable. It reads no clock:
"today" / "through" / "on" are always caller-supplied parameters, which is what
makes projection free and the fold fully deterministic.

Nothing derived is ever persisted. The ledger is a deterministic fold over the
usage rows and the pay periods — microseconds for the whole history — recomputed
on demand so a usage/settings/holiday/tier edit can never leave a stale cache.

Pay periods
-----------
Pure 14-day arithmetic anchored at the hire date (a Monday). For 1-based period
index ``n``::

    start    = hire_date + (n - 1) * period_length_days
    end      = start + (period_length_days - 1)
    pay_date = end + pay_date_offset_days

``period_index_for(d)`` is the inverse: ``(d - hire) // period_length + 1``. A
date before the hire date has no period and raises ``ValueError``.

Per-period order of operations (THE CONTRACT — do not reorder)
--------------------------------------------------------------
``prev`` is the balance after the previous period (``0.0`` before period 1).
Each period is folded in exactly this order:

1. **ROLLOVER** — only for the period containing Jan 1 (it straddles Jan 1,
   ``start.year < end.year``, or starts exactly on it — 2029-01-01 is a period
   start for the default hire date): forfeit everything above
   ``rollover_hours`` from the *incoming* balance before this period accrues or
   is used::

       lost_to_rollover = max(0, prev - rollover_hours)
       prev             = min(prev, rollover_hours)

2. **ACCRUE + USE, then CAP** — accrue the (rounded) per-period rate, subtract
   this period's PTO usage, then clamp to the hard cap. Subtracting usage
   *before* capping means usage inside a capped period frees headroom (prev 360,
   use 8, accrue 6.77 -> 358.77) — usage brings the balance down, never a
   retroactive credit::

       pto_used    = Σ non-PH usage hours with start <= date <= end
       gross       = prev + accrual_rate(end) - pto_used
       balance     = round(min(gross, max_balance_hours), 2)
       lost_to_cap = max(0, gross - balance)

   The running ``balance`` is rounded to 2 decimals every step; the per-period
   rate is itself pre-rounded (``round(annual_hours / periods_per_year, 2)`` when
   ``round_period_accrual`` is set) — both are required to replay the source
   spreadsheet exactly.

3. **PH** — personal holidays are a parallel calendar-year bucket that never
   touches the PTO fold::

       ph_remaining(year) = ph_annual_hours - Σ PH hours in that year   (clamp 0)

Accrual rate / tier rule
------------------------
A period accrues at the tier whose ``starts_on`` is the latest one that is still
``<= period_end``. So the tier bump lands on the first period whose *end* reaches
the anniversary, not its start.

``balance_on(d)`` semantics
---------------------------
Returns the *end-of-period* balance of the period **containing** ``d`` — it
includes that whole period's accrual and usage ("reflects the pay period in
progress"), matching the source spreadsheet.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

# --------------------------------------------------------------------------- #
# Immutable value types
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Tier:
    """A tenure tier: from ``starts_on`` onward, accrue ``annual_hours``/year."""

    starts_on: date
    annual_hours: float


@dataclass(frozen=True, slots=True)
class EngineConfig:
    """All constants the fold needs. Built from the DB by ``domain`` (Phase 3)."""

    hire_date: date
    period_length_days: int
    pay_date_offset_days: int
    periods_per_year: int
    hours_per_day: float
    max_balance_hours: float
    rollover_hours: float
    ph_annual_hours: float
    projection_horizon_months: int
    round_period_accrual: bool
    tiers: tuple[Tier, ...]


@dataclass(frozen=True, slots=True)
class UsageItem:
    """One usage record, decoupled from the SQLModel row."""

    date: date
    hours: float
    is_ph: bool = False


@dataclass(frozen=True, slots=True)
class PeriodRow:
    """One folded pay period — everything needed to render a ledger row."""

    index: int
    start: date
    end: date
    pay_date: date
    accrual: float
    pto_used: float
    ph_used: float
    balance: float
    lost_to_cap: float
    lost_to_rollover: float
    annual_hours: float


@dataclass(frozen=True, slots=True)
class BalanceSnapshot:
    """A point-in-time answer for ``balance_on`` / dashboard stat cards."""

    as_of: date
    period: int
    pto_balance: float
    ph_granted: float
    ph_used: float
    ph_remaining: float
    warnings: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class YearStats:
    """Per-calendar-year rollup for the stats endpoint.

    ``pto_used`` = ``pto_taken`` + ``pto_planned`` (split at ``today``).
    ``partial`` marks a year the ledger does not cover end to end (the hire
    year, or the last year cut off by ``through``).
    """

    year: int
    accrued: float
    pto_used: float
    pto_taken: float
    pto_planned: float
    ph_used: float
    ph_granted: float
    ph_remaining: float
    lost_to_cap: float
    lost_to_rollover: float
    end_balance: float
    partial: bool


# --------------------------------------------------------------------------- #
# Periods
# --------------------------------------------------------------------------- #


def period_index_for(cfg: EngineConfig, d: date) -> int:
    """1-based index of the pay period containing ``d``.

    Raises ``ValueError`` for a date before the hire date (no period exists).
    """
    if d < cfg.hire_date:
        raise ValueError(
            f"date {d.isoformat()} precedes hire date {cfg.hire_date.isoformat()}"
        )
    return (d - cfg.hire_date).days // cfg.period_length_days + 1


def period_bounds(cfg: EngineConfig, index: int) -> tuple[date, date, date]:
    """``(start, end, pay_date)`` for a 1-based period ``index``."""
    if index < 1:
        raise ValueError(f"period index must be >= 1, got {index}")
    start = cfg.hire_date + timedelta(days=(index - 1) * cfg.period_length_days)
    end = start + timedelta(days=cfg.period_length_days - 1)
    pay_date = end + timedelta(days=cfg.pay_date_offset_days)
    return start, end, pay_date


def contains_jan1(start: date, end: date) -> bool:
    """True for the one period per year whose window includes Jan 1."""
    return start.year < end.year or (start.month == 1 and start.day == 1)


def accrual_rate(cfg: EngineConfig, period_end: date) -> float:
    """Per-period accrual for a period ending on ``period_end``.

    Uses the tier whose ``starts_on`` is the latest one ``<= period_end``. The
    rate is ``round(annual_hours / periods_per_year, 2)`` when
    ``round_period_accrual`` is set — the rounding the spreadsheet uses.
    """
    tiers = sorted(cfg.tiers, key=lambda t: t.starts_on)
    applicable = [t for t in tiers if t.starts_on <= period_end]
    tier = applicable[-1] if applicable else tiers[0]
    rate = tier.annual_hours / cfg.periods_per_year
    return round(rate, 2) if cfg.round_period_accrual else rate


def _annual_hours_for(cfg: EngineConfig, period_end: date) -> float:
    tiers = sorted(cfg.tiers, key=lambda t: t.starts_on)
    applicable = [t for t in tiers if t.starts_on <= period_end]
    tier = applicable[-1] if applicable else tiers[0]
    return tier.annual_hours


# --------------------------------------------------------------------------- #
# The fold
# --------------------------------------------------------------------------- #


def step_period(
    cfg: EngineConfig,
    prev_balance: float,
    index: int,
    pto_used: float = 0.0,
    ph_used: float = 0.0,
) -> PeriodRow:
    """Fold a single pay period per the order-of-operations contract.

    ``prev_balance`` is the balance leaving the previous period. The returned
    ``PeriodRow.balance`` is the balance to carry into the next period. This is
    the single source of truth for the fold — ``compute_ledger`` just drives it
    period by period.
    """
    start, end, pay_date = period_bounds(cfg, index)

    # 1. ROLLOVER — clamp the incoming balance for the period containing Jan 1.
    lost_to_rollover = 0.0
    prev = prev_balance
    if contains_jan1(start, end):
        lost_to_rollover = max(0.0, prev - cfg.rollover_hours)
        prev = min(prev, cfg.rollover_hours)

    # 2. ACCRUE + USE, then CAP.
    rate = accrual_rate(cfg, end)
    gross = prev + rate - pto_used
    balance = round(min(gross, cfg.max_balance_hours), 2)
    lost_to_cap = round(max(0.0, gross - balance), 2)
    lost_to_rollover = round(lost_to_rollover, 2)

    return PeriodRow(
        index=index,
        start=start,
        end=end,
        pay_date=pay_date,
        accrual=rate,
        pto_used=round(pto_used, 2),
        ph_used=round(ph_used, 2),
        balance=balance,
        lost_to_cap=lost_to_cap,
        lost_to_rollover=lost_to_rollover,
        annual_hours=_annual_hours_for(cfg, end),
    )


def _validate_usage(cfg: EngineConfig, usage: list[UsageItem]) -> None:
    for item in usage:
        if item.date < cfg.hire_date:
            raise ValueError(
                f"usage date {item.date.isoformat()} precedes hire date "
                f"{cfg.hire_date.isoformat()}"
            )


def compute_ledger(
    cfg: EngineConfig, usage: list[UsageItem], through: date
) -> list[PeriodRow]:
    """Fold every period from period 1 through the period containing ``through``.

    Usage is bucketed into the period whose ``[start, end]`` window contains the
    entry's date; multiple entries on one date are summed, PTO and PH into their
    own buckets. Raises ``ValueError`` if any usage predates the hire date.
    """
    _validate_usage(cfg, usage)
    last_index = period_index_for(cfg, through)

    rows: list[PeriodRow] = []
    prev = 0.0
    for index in range(1, last_index + 1):
        start, end, _pay = period_bounds(cfg, index)
        pto_used = 0.0
        ph_used = 0.0
        for item in usage:
            if start <= item.date <= end:
                if item.is_ph:
                    ph_used += item.hours
                else:
                    pto_used += item.hours
        row = step_period(cfg, prev, index, pto_used=pto_used, ph_used=ph_used)
        prev = row.balance
        rows.append(row)
    return rows


def balance_on(
    cfg: EngineConfig, usage: list[UsageItem], on: date
) -> BalanceSnapshot:
    """End-of-period PTO balance for the period containing ``on``, plus the PH
    calendar-year bucket and any warnings.
    """
    rows = compute_ledger(cfg, usage, on)
    row = rows[-1]

    year = on.year
    granted = cfg.ph_annual_hours
    ph_used = round(
        sum(
            item.hours
            for item in usage
            if item.is_ph and item.date.year == year and item.date <= row.end
        ),
        2,
    )
    ph_remaining = max(0.0, round(granted - ph_used, 2))

    warnings: list[str] = []
    if row.balance < 0:
        warnings.append(
            f"PTO balance is negative ({row.balance:.2f} h) — usage exceeds accrued"
        )
    if ph_used > granted:
        warnings.append(
            f"Personal-holiday hours over-used ({ph_used:.2f} of {granted:.2f} h) "
            f"in {year}"
        )

    return BalanceSnapshot(
        as_of=on,
        period=row.index,
        pto_balance=row.balance,
        ph_granted=granted,
        ph_used=ph_used,
        ph_remaining=ph_remaining,
        warnings=tuple(warnings),
    )


def loss_warnings(rows: list[PeriodRow]) -> list[str]:
    """Human-readable warnings for any cap/rollover forfeitures in ``rows``.

    Pure helper the projection route reuses to flag that a span between today
    and a target date would lose hours to the cap or the year-end rollover.
    """
    warnings: list[str] = []
    for row in rows:
        if row.lost_to_cap > 0:
            warnings.append(
                f"Period {row.index} ({row.end.isoformat()}): "
                f"{row.lost_to_cap:.2f} h lost to the {row.balance:.0f} h cap"
            )
        if row.lost_to_rollover > 0:
            warnings.append(
                f"Period {row.index} ({row.end.isoformat()}): "
                f"{row.lost_to_rollover:.2f} h forfeited at year-end rollover"
            )
    return warnings


def yearly_stats(
    cfg: EngineConfig,
    usage: list[UsageItem],
    through: date,
    today: date | None = None,
) -> list[YearStats]:
    """Per-calendar-year totals over the ledger through ``through``.

    Attribution rules — each figure lands in the year a person would expect:

    * **accrued / lost to cap** — the year the period *ends* (when it is paid).
    * **PTO / PH used** — each usage entry's own *date* year, matching
      ``balance_on``'s PH bucket and the Usage page's year filter (a Dec 29 day
      off inside a Jan-straddling period is the old year's).
    * **lost to rollover** — the year that *ended*: hours forfeited on Jan 1 of
      Y were built up in Y-1.
    * **end_balance** — the balance leaving the last period that ends in Y.

    ``today`` (default ``through``) splits usage into taken (``<= today``) and
    planned (``> today``).
    """
    rows = compute_ledger(cfg, usage, through)
    if not rows:
        return []
    cutoff = today or through
    last_end = rows[-1].end

    years: dict[int, dict[str, float]] = {}

    def bucket(y: int) -> dict[str, float]:
        return years.setdefault(
            y,
            {
                "accrued": 0.0, "taken": 0.0, "planned": 0.0, "ph": 0.0,
                "cap": 0.0, "roll": 0.0, "end_balance": 0.0,
            },
        )

    for row in rows:
        b = bucket(row.end.year)
        b["accrued"] += row.accrual
        b["cap"] += row.lost_to_cap
        b["end_balance"] = row.balance
        if row.lost_to_rollover:
            bucket(row.end.year - 1)["roll"] += row.lost_to_rollover

    for item in usage:
        if item.date > last_end:
            continue
        b = bucket(item.date.year)
        if item.is_ph:
            b["ph"] += item.hours
        elif item.date <= cutoff:
            b["taken"] += item.hours
        else:
            b["planned"] += item.hours

    first_start = rows[0].start
    out: list[YearStats] = []
    for y, b in sorted(years.items()):
        partial = first_start > date(y, 1, 1) or last_end < date(y, 12, 31)
        out.append(
            YearStats(
                year=y,
                accrued=round(b["accrued"], 2),
                pto_used=round(b["taken"] + b["planned"], 2),
                pto_taken=round(b["taken"], 2),
                pto_planned=round(b["planned"], 2),
                ph_used=round(b["ph"], 2),
                ph_granted=cfg.ph_annual_hours,
                ph_remaining=max(0.0, round(cfg.ph_annual_hours - b["ph"], 2)),
                lost_to_cap=round(b["cap"], 2),
                lost_to_rollover=round(b["roll"], 2),
                end_balance=round(b["end_balance"], 2),
                partial=partial,
            )
        )
    return out
