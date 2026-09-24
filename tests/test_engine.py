"""Accrual engine — ~70% of the app's value lives in these assertions."""

from __future__ import annotations

import csv
import dataclasses
from datetime import date
from pathlib import Path

import pytest

from epoch.engine import (
    UsageItem,
    accrual_rate,
    balance_on,
    compute_ledger,
    loss_warnings,
    period_bounds,
    step_period,
    yearly_stats,
)

FIXTURE_CSV = Path(__file__).parent / "fixtures" / "usage_export.csv"


# --------------------------------------------------------------------------- #
# Rates & tiers
# --------------------------------------------------------------------------- #


def test_accrual_rates(cfg):
    assert accrual_rate(cfg, date(2026, 7, 19)) == 6.77
    assert accrual_rate(cfg, date(2028, 2, 1)) == 8.31
    assert accrual_rate(cfg, date(2033, 2, 1)) == 9.85


def test_tier_boundary_period_130_vs_131(cfg):
    _s130, e130, _p130 = period_bounds(cfg, 130)
    _s131, e131, _p131 = period_bounds(cfg, 131)
    assert e130 == date(2028, 1, 2)
    assert e131 == date(2028, 1, 16)
    assert accrual_rate(cfg, e130) == 6.77  # last period at the hire tier
    assert accrual_rate(cfg, e131) == 8.31  # first period at the 5-year tier


# --------------------------------------------------------------------------- #
# HARD GATE — the sheet regression
# --------------------------------------------------------------------------- #


def test_sheet_regression_replays_exactly(cfg):
    """Fold from 111.38 with 6.77/period + usage {8h in 3rd, 16h in 6th}.

    Must replay the visible spreadsheet rows exactly, ending at 134.77 (the
    balance on 2026-07-08).
    """
    expected = [118.15, 124.92, 123.69, 130.46, 137.23, 128.00, 134.77]
    # 0-based offsets into a 7-period window: 3rd period -> 2, 6th period -> 5.
    usage_by_offset = {2: 8.0, 5: 16.0}

    prev = 111.38
    balances: list[float] = []
    for offset in range(7):
        index = 80 + offset  # a clean run of 2026 periods, all at rate 6.77
        row = step_period(cfg, prev, index, pto_used=usage_by_offset.get(offset, 0.0))
        assert row.accrual == 6.77
        assert row.lost_to_rollover == 0.0
        assert row.lost_to_cap == 0.0
        prev = row.balance
        balances.append(row.balance)

    assert balances == expected


# --------------------------------------------------------------------------- #
# Golden CSV acceptance test (skips until the user drops in the real export)
# --------------------------------------------------------------------------- #


def _parse_golden_csv(path: Path) -> list[UsageItem]:
    """Stdlib-only parse of the sheet export, so Phase 3's csv_io can't break it.

    Columns: Date, Hours, Type, Reason, Requested. Skips 0-hour padding rows,
    accepts ISO and M/D/YYYY dates, maps "Personal Holiday" -> PH.
    """
    items: list[UsageItem] = []
    with path.open(newline="") as fh:
        for raw in csv.DictReader(fh):
            row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
            hours = float(row.get("hours") or 0)
            if hours == 0:
                continue  # weekend/holiday padding rows are not usage
            items.append(
                UsageItem(
                    date=_parse_date(row["date"]),
                    hours=hours,
                    is_ph="personal" in row.get("type", "").lower(),
                )
            )
    return items


def _parse_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        month, day, year = (int(part) for part in value.split("/"))
        return date(year, month, day)


@pytest.mark.skipif(
    not FIXTURE_CSV.exists(),
    reason="real sheet export not provided yet (tests/fixtures/usage_export.csv)",
)
def test_golden_csv_matches_sheet(cfg):
    usage = _parse_golden_csv(FIXTURE_CSV)
    snap = balance_on(cfg, usage, date(2026, 7, 8))
    assert snap.pto_balance == 134.77

    rows = compute_ledger(cfg, usage, date(2026, 7, 8))
    assert max(row.balance for row in rows) == 137.23


# --------------------------------------------------------------------------- #
# Cap
# --------------------------------------------------------------------------- #


def test_cap_forfeits_excess(cfg):
    row = step_period(cfg, 358.0, 92)  # 358 + 6.77 = 364.77 -> capped
    assert row.balance == 360.00
    assert row.lost_to_cap == 4.77


def test_usage_in_capped_period_frees_headroom(cfg):
    # At the cap, usage brings the balance down; no retroactive credit.
    row = step_period(cfg, 360.0, 92, pto_used=8.0)  # 360 + 6.77 - 8
    assert row.balance == 358.77
    assert row.lost_to_cap == 0.0


def test_capped_hours_never_recovered(cfg):
    r1 = step_period(cfg, 360.0, 90)
    assert r1.balance == 360.00
    assert r1.lost_to_cap == 6.77
    r2 = step_period(cfg, r1.balance, 91)
    assert r2.balance == 360.00  # still pinned; the 6.77 is gone for good


# --------------------------------------------------------------------------- #
# Rollover
# --------------------------------------------------------------------------- #


def test_rollover_clamps_incoming(cfg):
    row = step_period(cfg, 250.0, 104)  # straddles Jan 1 2027
    assert row.lost_to_rollover == 10.0
    assert row.balance == 246.77  # min(250,240) + 6.77


def test_rollover_untouched_below_threshold(cfg):
    row = step_period(cfg, 239.0, 104)
    assert row.lost_to_rollover == 0.0
    assert row.balance == 245.77  # 239 + 6.77


def test_rollover_and_cap_compose(cfg):
    # Lower the cap so a single straddling period loses to BOTH rules.
    low_cap = dataclasses.replace(cfg, max_balance_hours=245.0)
    row = step_period(low_cap, 250.0, 104)
    assert row.lost_to_rollover == 10.0  # 250 -> 240
    assert row.balance == 245.00  # 240 + 6.77 = 246.77 -> capped at 245
    assert row.lost_to_cap == 1.77


# --------------------------------------------------------------------------- #
# Personal-holiday bucket
# --------------------------------------------------------------------------- #


def test_ph_bucket_independent_of_pto_fold(cfg):
    ph = [UsageItem(date(2026, 3, 2), 8.0, is_ph=True)]
    snap = balance_on(cfg, ph, date(2026, 7, 8))
    assert snap.ph_granted == 16.0
    assert snap.ph_used == 8.0
    assert snap.ph_remaining == 8.0
    # The PTO fold is untouched by PH usage.
    assert snap.pto_balance == balance_on(cfg, [], date(2026, 7, 8)).pto_balance


def test_ph_remaining_clamps_at_zero(cfg):
    ph = [
        UsageItem(date(2026, 2, 2), 8.0, is_ph=True),
        UsageItem(date(2026, 3, 2), 8.0, is_ph=True),
        UsageItem(date(2026, 4, 2), 8.0, is_ph=True),  # 24 > 16 granted
    ]
    snap = balance_on(cfg, ph, date(2026, 7, 8))
    assert snap.ph_used == 24.0
    assert snap.ph_remaining == 0.0
    assert any("over-used" in w for w in snap.warnings)


def test_ph_resets_each_year(cfg):
    ph = [
        UsageItem(date(2026, 3, 2), 16.0, is_ph=True),
        UsageItem(date(2027, 3, 2), 8.0, is_ph=True),
    ]
    snap_2026 = balance_on(cfg, ph, date(2026, 7, 8))
    assert snap_2026.ph_used == 16.0
    assert snap_2026.ph_remaining == 0.0

    snap_2027 = balance_on(cfg, ph, date(2027, 7, 8))
    assert snap_2027.ph_used == 8.0  # 2026 usage does not carry over
    assert snap_2027.ph_remaining == 8.0


# --------------------------------------------------------------------------- #
# Edge cases
# --------------------------------------------------------------------------- #


def test_usage_before_hire_raises(cfg):
    with pytest.raises(ValueError):
        compute_ledger(cfg, [UsageItem(date(2023, 1, 8), 8.0)], date(2026, 7, 8))


def test_negative_balance_allowed_and_warns(cfg):
    usage = [UsageItem(date(2023, 1, 20), 200.0)]  # blow past the accrual in period 1
    snap = balance_on(cfg, usage, date(2023, 1, 22))
    assert snap.pto_balance < 0
    assert any("negative" in w for w in snap.warnings)


def test_same_date_entries_are_summed(cfg):
    split = [
        UsageItem(date(2026, 3, 3), 4.0),
        UsageItem(date(2026, 3, 3), 4.0),
    ]
    single = [UsageItem(date(2026, 3, 3), 8.0)]
    on = date(2026, 3, 15)
    assert balance_on(cfg, split, on).pto_balance == balance_on(cfg, single, on).pto_balance


def test_projection_loss_warnings_appear_for_a_lossy_span(cfg):
    # Empty usage: the balance accrues into the cap, then the Jan-1 straddling
    # period 104 forfeits everything above the rollover threshold.
    rows = compute_ledger(cfg, [], date(2026, 12, 31))
    warns = loss_warnings(rows)
    assert any("cap" in w for w in warns)
    assert any("rollover" in w for w in warns)


def test_engine_is_deterministic(cfg):
    usage = [
        UsageItem(date(2026, 3, 3), 8.0),
        UsageItem(date(2026, 5, 4), 8.0, is_ph=True),
    ]
    on = date(2026, 7, 8)
    assert compute_ledger(cfg, usage, on) == compute_ledger(cfg, usage, on)
    assert balance_on(cfg, usage, on) == balance_on(cfg, usage, on)


def test_yearly_stats_rollup(cfg):
    usage = [
        UsageItem(date(2026, 3, 3), 8.0),
        UsageItem(date(2026, 5, 4), 8.0, is_ph=True),
    ]
    stats = {s.year: s for s in yearly_stats(cfg, usage, date(2026, 12, 15))}
    assert 2026 in stats
    assert stats[2026].pto_used == 8.0
    assert stats[2026].ph_used == 8.0


# --------------------------------------------------------------------------- #
# Year-boundary attribution
# --------------------------------------------------------------------------- #


def test_rollover_fires_for_a_period_starting_on_jan_1(cfg):
    # 2029-01-01 is exactly a period start for the default hire date, so no
    # period *straddles* Jan 1 that year — the rollover must still apply.
    rows = compute_ledger(cfg, [], date(2029, 1, 10))
    jan = next(r for r in rows if r.start == date(2029, 1, 1))
    assert jan.lost_to_rollover > 0
    dec = next(r for r in rows if r.end == date(2028, 12, 31))
    assert dec.lost_to_rollover == 0
    # Exactly one rollover per calendar year.
    rolls = [r.start.year for r in rows if r.lost_to_rollover > 0]
    assert len(rolls) == len(set(r.end.year for r in rows if r.lost_to_rollover > 0))


def test_yearly_stats_counts_late_december_usage_in_its_own_year(cfg):
    # Dec 29, 2025 sits in the period 2025-12-22..2026-01-04 (ends in 2026).
    usage = [
        UsageItem(date(2025, 12, 29), 8.0),
        UsageItem(date(2025, 12, 30), 8.0, is_ph=True),
    ]
    stats = {s.year: s for s in yearly_stats(cfg, usage, date(2026, 12, 31))}
    assert stats[2025].pto_used == 8.0
    assert stats[2025].ph_used == 8.0
    assert stats[2026].pto_used == 0.0
    assert stats[2026].ph_used == 0.0


def test_yearly_stats_rollover_loss_belongs_to_the_year_that_ended(cfg):
    stats = {s.year: s for s in yearly_stats(cfg, [], date(2027, 3, 1))}
    assert stats[2026].lost_to_rollover > 0  # forfeited at Jan 1, 2027
    assert stats[2027].lost_to_rollover == 0


def test_yearly_stats_splits_taken_and_planned(cfg):
    usage = [UsageItem(date(2026, 3, 3), 8.0), UsageItem(date(2026, 11, 25), 24.0)]
    stats = {
        s.year: s
        for s in yearly_stats(cfg, usage, date(2026, 12, 31), today=date(2026, 9, 23))
    }
    assert stats[2026].pto_taken == 8.0
    assert stats[2026].pto_planned == 24.0
    assert stats[2026].pto_used == 32.0


def test_yearly_stats_flags_partial_years(cfg):
    stats = {s.year: s for s in yearly_stats(cfg, [], date(2027, 3, 1))}
    assert stats[2023].partial  # hired Jan 9
    assert not stats[2025].partial
    assert stats[2027].partial  # cut off by `through`


def test_yearly_stats_ph_remaining_and_end_balance(cfg):
    usage = [UsageItem(date(2026, 3, 2), 8.0, is_ph=True)]
    stats = {s.year: s for s in yearly_stats(cfg, usage, date(2026, 12, 31))}
    assert stats[2026].ph_granted == 16.0
    assert stats[2026].ph_remaining == 8.0
    rows = compute_ledger(cfg, usage, date(2026, 12, 31))
    last_2026 = [r for r in rows if r.end.year == 2026][-1]
    assert stats[2026].end_balance == last_2026.balance
