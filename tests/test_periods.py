"""Period arithmetic — the anchor everything else folds over."""

from __future__ import annotations

from datetime import date

import pytest

from epoch.engine import period_bounds, period_index_for


def test_period_one_bounds(cfg):
    assert period_bounds(cfg, 1) == (
        date(2023, 1, 9),
        date(2023, 1, 22),
        date(2023, 1, 27),
    )


def test_period_92_is_the_sheet_row(cfg):
    # The sheet's "row 94" period, offset by its 2 header rows.
    assert period_bounds(cfg, 92) == (
        date(2026, 7, 6),
        date(2026, 7, 19),
        date(2026, 7, 24),
    )


def test_period_index_for_reference_date(cfg):
    assert period_index_for(cfg, date(2026, 7, 8)) == 92


@pytest.mark.parametrize(
    "d,expected",
    [
        (date(2026, 7, 5), 91),  # last day of period 91
        (date(2026, 7, 6), 92),  # first day of period 92
        (date(2026, 7, 19), 92),  # last day of period 92
        (date(2026, 7, 20), 93),  # first day of period 93
    ],
)
def test_period_boundaries(cfg, d, expected):
    assert period_index_for(cfg, d) == expected


def test_hire_date_is_period_one(cfg):
    assert period_index_for(cfg, cfg.hire_date) == 1


def test_pre_hire_raises(cfg):
    with pytest.raises(ValueError):
        period_index_for(cfg, date(2023, 1, 8))


def test_period_index_below_one_raises(cfg):
    with pytest.raises(ValueError):
        period_bounds(cfg, 0)


def test_period_104_straddles_new_year(cfg):
    start, end, _pay = period_bounds(cfg, 104)
    assert start == date(2026, 12, 21)
    assert end == date(2027, 1, 3)
    assert start.year < end.year  # the rollover trigger


def test_round_trip_index_matches_bounds(cfg):
    # Every period's start and end must map back to that same index.
    for index in (1, 50, 92, 104, 130, 131, 200):
        start, end, _pay = period_bounds(cfg, index)
        assert period_index_for(cfg, start) == index
        assert period_index_for(cfg, end) == index
