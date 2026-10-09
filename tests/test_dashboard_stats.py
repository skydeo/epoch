"""``dashboard_stats`` YTD figures: by entry date vs. by pay date."""

from datetime import date

from epoch.engine import UsageItem
from epoch.services import dashboard_stats


def test_paid_ytd_follows_pay_date_not_entry_date(cfg):
    usage = [
        UsageItem(date(2025, 12, 23), 8.0),  # period 12/22–1/4, paid 1/9/2026
        UsageItem(date(2025, 12, 26), 8.0),  # same period
        UsageItem(date(2026, 1, 2), 8.0),  # same period
        UsageItem(date(2026, 2, 20), 8.0),  # period 2/16–3/1, paid 3/6 — not yet
    ]
    stats = dashboard_stats(cfg, usage, date(2026, 3, 1))

    assert stats["pto_used_ytd"] == 16.0  # 1/2 + 2/20, by calendar date
    assert stats["pto_paid_ytd"] == 24.0  # the whole 1/9 paycheck, nothing after


def _paid_balance(cfg, usage, period_end):
    """Ledger balance of the period ending ``period_end``."""
    from epoch.engine import compute_ledger

    return next(r.balance for r in compute_ledger(cfg, usage, period_end) if r.end == period_end)


def test_balance_is_last_paycheck_not_current_period(cfg):
    # 10/8 sits in 9/28–10/11 (pays 10/16); the last paycheck was 10/2.
    stats = dashboard_stats(cfg, [], date(2026, 10, 8))

    assert stats["balance_as_of"] == "2026-10-02"
    assert stats["pto_taken_since"] == 0.0
    assert stats["current_balance"] == _paid_balance(cfg, [], date(2026, 9, 27))
    assert stats["next_pay_date"] == date(2026, 10, 16)


def test_pto_taken_since_paycheck_is_subtracted_but_not_future_days(cfg):
    usage = [
        UsageItem(date(2026, 10, 5), 8.0),  # taken, unpaid period
        UsageItem(date(2026, 10, 9), 8.0),  # booked, still ahead
    ]
    stats = dashboard_stats(cfg, usage, date(2026, 10, 8))

    assert stats["pto_taken_since"] == 8.0
    assert stats["current_balance"] == round(
        _paid_balance(cfg, usage, date(2026, 9, 27)) - 8.0, 2
    )


def test_period_ended_but_unpaid_still_waits_for_payday(cfg):
    usage = [UsageItem(date(2026, 10, 5), 8.0)]
    stats = dashboard_stats(cfg, usage, date(2026, 10, 14))  # 9/28–10/11 ended

    assert stats["balance_as_of"] == "2026-10-02"
    assert stats["pto_taken_since"] == 8.0
    assert stats["next_pay_date"] == date(2026, 10, 16)


def test_payday_credits_the_period_and_moves_next_pay(cfg):
    usage = [UsageItem(date(2026, 10, 5), 8.0)]
    stats = dashboard_stats(cfg, usage, date(2026, 10, 16))

    assert stats["balance_as_of"] == "2026-10-16"
    assert stats["pto_taken_since"] == 0.0  # now inside the paid period
    assert stats["current_balance"] == _paid_balance(cfg, usage, date(2026, 10, 11))
    assert stats["next_pay_date"] == date(2026, 10, 30)
