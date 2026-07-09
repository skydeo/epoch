// Number/date formatting that mirrors the server templates (HANDOFF §6):
//  * balances/accruals → 2 decimal places
//  * whole-hour counts  → "%g" style (no trailing zeros)

/** Fixed 2dp, e.g. 134.77. */
export function fmt2(n: number): string {
  return n.toFixed(2);
}

/** "%g"-style: drop trailing zeros (8, 6.77, 16). */
export function fmtG(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** Short month/day for pay dates and axis ticks, e.g. "7/24". */
export function fmtMonthDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

/** "Jul 8, 2026" for the dashboard subtitle. */
export function fmtLongDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Chart axis label: "M/D/YY" from an ISO date. */
export function fmtChartLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${String(y).slice(2)}`;
}
