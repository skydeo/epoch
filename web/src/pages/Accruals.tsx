import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { DataTable, type Column, type RowState } from "../components/DataTable";
import { Badge, Button, Field, inputCls } from "../components/ui";
import { EmptyState, ErrorState, Spinner } from "../components/states";
import { api, queryKeys } from "../lib/api";
import { fmtRange, fmtShort } from "../lib/date";
import { fmt2, fmtG, fmtChartLabel, fmtMonthDay } from "../lib/format";
import type { AccrualRow, YearStat } from "../types";

// Status pills — Past muted / Current cobalt / Upcoming teal (HANDOFF §3).
const STATUS: Record<
  AccrualRow["state"],
  { label: string; color: string; bg: string }
> = {
  past: { label: "Past", color: "var(--text-2)", bg: "var(--surface-2)" },
  current: { label: "Current", color: "var(--primary)", bg: "var(--primary-soft)" },
  future: { label: "Upcoming", color: "var(--teal)", bg: "var(--teal-soft)" },
};

const LEGEND = [
  { color: "var(--text-3)", label: "Past" },
  { color: "var(--primary)", label: "Current" },
  { color: "var(--teal)", label: "Upcoming" },
];

// Zeros render as a muted "·"; PTO in coral, PH in amber (HANDOFF §3).
function UsedCell({ value, color }: { value: number; color: string }) {
  if (!value)
    return <span className="font-display text-ink-3 tabular-nums">·</span>;
  return (
    <span
      className="font-display font-semibold tabular-nums"
      style={{ color }}
    >
      {fmtG(value)}
    </span>
  );
}

function LostBadges({ row }: { row: AccrualRow }) {
  const badges: string[] = [];
  if (row.lost_to_cap > 0) badges.push(`−${fmtG(row.lost_to_cap)} cap`);
  if (row.lost_to_rollover > 0)
    badges.push(`−${fmtG(row.lost_to_rollover)} roll`);
  if (badges.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {badges.map((b) => (
        <Badge key={b} color="var(--warn)" bg="var(--warn-soft)">
          {b}
        </Badge>
      ))}
    </div>
  );
}

const COLUMNS: Column<AccrualRow>[] = [
  {
    key: "index",
    header: "#",
    label: "Period",
    render: (r) => (
      <span className="font-display text-[13px] font-semibold text-ink-3">
        {r.index}
      </span>
    ),
  },
  {
    key: "period",
    header: "Pay period",
    render: (r) => (
      <span className="font-semibold text-ink">
        {fmtMonthDay(r.start)} – {fmtMonthDay(r.end)}
      </span>
    ),
  },
  {
    key: "pay",
    header: "Pay date",
    render: (r) => (
      <span className="text-[13.5px] text-ink-2">{fmtChartLabel(r.pay_date)}</span>
    ),
  },
  {
    key: "pto",
    header: "PTO",
    label: "PTO used",
    align: "right",
    render: (r) => <UsedCell value={r.pto_used} color="var(--danger)" />,
  },
  {
    key: "ph",
    header: "PH",
    label: "PH used",
    align: "right",
    render: (r) => <UsedCell value={r.ph_used} color="var(--warn)" />,
  },
  {
    key: "balance",
    header: "Balance",
    align: "right",
    render: (r) => (
      <span className="flex flex-col items-end gap-1">
        <span
          className="font-display font-bold tabular-nums"
          style={{ color: r.is_current ? "var(--primary)" : "var(--text)" }}
        >
          {fmt2(r.balance)}
        </span>
        <LostBadges row={r} />
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    align: "right",
    render: (r) => {
      const s = STATUS[r.state];
      return (
        <Badge color={s.color} bg={s.bg}>
          {s.label}
        </Badge>
      );
    },
  },
];

const rowState = (r: AccrualRow): RowState => r.state;

// Dense two-line mobile row: dates + balance, then pay date + what moved.
function MobileAccrualRow({ r }: { r: AccrualRow }) {
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[15px] font-semibold">
          {fmtRange(r.start, r.end)}
        </span>
        {r.is_current && (
          <span className="rounded-pill bg-primary px-[7px] py-px text-[11px] font-bold text-[var(--bg-elev)]">
            Now
          </span>
        )}
        <span className="flex-1" />
        <span className="font-display text-[16px] font-bold tabular-nums">
          {fmt2(r.balance)}
          <span className="text-[11.5px] font-medium text-ink-3"> h</span>
        </span>
      </div>
      <div className="flex items-center gap-2 text-[12.5px] text-ink-3">
        <span>
          {r.state === "past" ? "Paid" : "Pays"} {fmtShort(r.pay_date, { year: false })}
        </span>
        <span className="flex-1" />
        {r.lost_to_cap > 0 && (
          <Badge color="var(--warn)" bg="var(--warn-soft)">−{fmtG(r.lost_to_cap)} cap</Badge>
        )}
        {r.lost_to_rollover > 0 && (
          <Badge color="var(--warn)" bg="var(--warn-soft)">−{fmtG(r.lost_to_rollover)} roll</Badge>
        )}
        {r.ph_used > 0 && (
          <span className="font-display font-semibold text-warn">−{fmtG(r.ph_used)} PH</span>
        )}
        {r.pto_used > 0 && (
          <span className="font-display font-semibold text-danger">−{fmtG(r.pto_used)} PTO</span>
        )}
        <span className="font-display text-mint">+{fmtG(r.accrual)}</span>
      </div>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  unit = "h",
  color,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] text-ink-3 min-[900px]:text-[12.5px]">{label}</div>
      <div
        className="font-display text-[18px] font-semibold tabular-nums min-[900px]:text-[22px]"
        style={color ? { color } : undefined}
      >
        {value}
        <span className="text-[12px] font-medium text-ink-3"> {unit}</span>
      </div>
      {sub && <div className="text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

// The selected year at a glance — replaces the per-year table that used to
// live on the Projection page.
function YearSummary({ stat, thisYear }: { stat: YearStat; thisYear: number }) {
  const future = stat.year >= thisYear;
  const lost = stat.lost_to_cap + stat.lost_to_rollover;
  const note =
    stat.year === thisYear
      ? "projected through Dec 31"
      : stat.year > thisYear
        ? "projection"
        : null;
  return (
    <section
      aria-label={`${stat.year} summary`}
      className="mb-3 rounded-[14px] border border-line bg-surface px-3 pb-3 pt-2.5 min-[900px]:mb-4 min-[900px]:rounded-card min-[900px]:px-5 min-[900px]:py-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-ink-3">
          {stat.year}
        </span>
        {note && <span className="text-[12px] text-ink-3">· {note}</span>}
        {stat.partial && (
          <Badge color="var(--text-2)" bg="var(--surface-2)">
            partial year
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-3 gap-x-2 gap-y-2.5 min-[900px]:grid-cols-6">
        <SummaryCell label="Accrued" value={fmtG(stat.accrued)} />
        <SummaryCell label="PTO taken" value={fmtG(stat.pto_taken)} color="var(--danger)" />
        <SummaryCell label="Planned" value={fmtG(stat.pto_planned)} />
        <SummaryCell
          label="Personal holiday"
          value={fmtG(stat.ph_used)}
          unit={`/ ${fmtG(stat.ph_granted)} h`}
          color="var(--warn)"
        />
        <SummaryCell
          label={future ? "Year-end est." : "Year-end"}
          value={fmtG(stat.end_balance)}
          color="var(--primary)"
        />
        <SummaryCell
          label="Forfeited"
          value={fmtG(lost)}
          color={lost > 0 ? "var(--warn)" : undefined}
          sub={
            lost > 0
              ? [
                  stat.lost_to_cap > 0 ? `${fmtG(stat.lost_to_cap)} cap` : "",
                  stat.lost_to_rollover > 0 ? `${fmtG(stat.lost_to_rollover)} at Jan 1` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
        />
      </div>
    </section>
  );
}

const YEAR_COLUMNS: Column<YearStat>[] = [
  {
    key: "year",
    header: "Year",
    render: (y) => (
      <span className="font-display font-semibold">
        {y.year}
        {y.partial && <span className="ml-1.5 text-[11.5px] font-medium text-ink-3">partial</span>}
      </span>
    ),
  },
  { key: "accrued", header: "Accrued", align: "right", render: (y) => <span className="font-display tabular-nums">{fmtG(y.accrued)}</span> },
  { key: "taken", header: "PTO taken", align: "right", render: (y) => <UsedCell value={y.pto_taken} color="var(--danger)" /> },
  { key: "planned", header: "Planned", align: "right", render: (y) => <UsedCell value={y.pto_planned} color="var(--text)" /> },
  { key: "ph", header: "PH used", align: "right", render: (y) => <UsedCell value={y.ph_used} color="var(--warn)" /> },
  { key: "end", header: "Year-end", align: "right", render: (y) => <span className="font-display font-bold tabular-nums">{fmtG(y.end_balance)}</span> },
  {
    key: "lost",
    header: "Forfeited",
    align: "right",
    render: (y) => <UsedCell value={y.lost_to_cap + y.lost_to_rollover} color="var(--warn)" />,
  },
];

function MobileYearRow({ y }: { y: YearStat }) {
  const lost = y.lost_to_cap + y.lost_to_rollover;
  return (
    <div className="flex flex-col gap-0.5 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-[15px] font-semibold">{y.year}</span>
        {y.partial && <span className="text-[11.5px] text-ink-3">partial</span>}
        <span className="flex-1" />
        <span className="text-[12px] text-ink-3">year-end</span>
        <span className="font-display text-[16px] font-bold tabular-nums">
          {fmtG(y.end_balance)}
          <span className="text-[11.5px] font-medium text-ink-3"> h</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-[12.5px] text-ink-3">
        <span>+{fmtG(y.accrued)} accrued</span>
        <span className="text-danger">−{fmtG(y.pto_taken)} taken</span>
        {y.pto_planned > 0 && <span>−{fmtG(y.pto_planned)} planned</span>}
        <span className="text-warn">{fmtG(y.ph_used)} PH</span>
        {lost > 0 && <span className="text-warn">{fmtG(lost)} lost</span>}
      </div>
    </div>
  );
}

export function Accruals() {
  const thisYear = new Date().getFullYear();
  // "all" → no year filter (and the all-years table); otherwise one year.
  const [year, setYear] = useState<number | "all">(thisYear);
  // Newest period first by default (current data at the top).
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const query = useQuery({
    queryKey: queryKeys.accruals(year === "all" ? undefined : year),
    queryFn: () => api.accruals(year === "all" ? undefined : year),
  });

  const stats = useQuery({ queryKey: queryKeys.stats(), queryFn: api.stats });
  const yearStat =
    year === "all" ? null : stats.data?.years.find((y) => y.year === year) ?? null;
  const statYears = useMemo(() => {
    const ys = [...(stats.data?.years ?? [])];
    return ys.reverse();
  }, [stats.data]);

  // Rows arrive ascending by period index; reverse for descending.
  const rows = useMemo(() => {
    const base = query.data?.rows ?? [];
    return sortDir === "asc" ? base : [...base].reverse();
  }, [query.data, sortDir]);

  // Ascending order puts the current period far down the list, so scroll it
  // into view. Descending (the default) already has it at the top — scrolling
  // there would only push the year summary off-screen.
  const scrollToKey = useMemo(() => {
    if (sortDir === "desc") return null;
    const cur = rows.find((r) => r.is_current);
    return cur ? cur.index : null;
  }, [rows, sortDir]);

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Accruals"
        blurb="One row per pay period — accrued on the fly from the rules, never stored."
      />

      <div className="mb-3 flex flex-wrap items-end gap-2.5 min-[900px]:mb-4 min-[900px]:gap-3.5">
        <Field label="Year" className="min-w-0">
          <select
            className={inputCls}
            value={year}
            onChange={(e) =>
              setYear(e.target.value === "all" ? "all" : Number(e.target.value))
            }
          >
            <option value="all">All periods</option>
            {(query.data?.years ?? []).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Button
          variant="ghost"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          aria-label={`Sort by period ${sortDir === "asc" ? "descending" : "ascending"}`}
        >
          Period {sortDir === "asc" ? "↑" : "↓"}
        </Button>
        <div className="ml-auto hidden flex-wrap items-center gap-4 min-[900px]:flex">
          {LEGEND.map((l) => (
            <span
              key={l.label}
              className="flex items-center gap-[7px] text-[12.5px] font-medium text-ink-2"
            >
              <span
                className="h-2.5 w-2.5 rounded-[3px]"
                style={{ background: l.color }}
              />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      {yearStat && <YearSummary stat={yearStat} thisYear={thisYear} />}
      {year === "all" && statYears.length > 0 && (
        <div className="mb-4">
          <h2 className="mb-2 px-0.5 text-[13px] font-bold text-ink-2">By year</h2>
          <DataTable
            ariaLabel="Totals by year"
            columns={YEAR_COLUMNS}
            rows={statYears}
            rowKey={(y) => y.year}
            gridTemplate="minmax(90px,1fr) repeat(6, minmax(70px,1fr))"
            minWidth={620}
            renderMobile={(y) => <MobileYearRow y={y} />}
          />
        </div>
      )}
      {year === "all" && (
        <h2 className="mb-2 px-0.5 text-[13px] font-bold text-ink-2">Pay periods</h2>
      )}

      {query.isPending && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <Spinner label="Loading ledger…" />
        </div>
      )}
      {query.isError && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <ErrorState
            message="Could not load the accrual ledger."
            onRetry={() => query.refetch()}
          />
        </div>
      )}
      {query.data &&
        (query.data.rows.length === 0 ? (
          <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
            <EmptyState message="No pay periods for this year." />
          </div>
        ) : (
          <DataTable
            ariaLabel="Accrual ledger"
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.index}
            rowState={rowState}
            gridTemplate="40px minmax(130px,1.5fr) 96px 56px 50px 116px 104px"
            minWidth={640}
            scrollToKey={scrollToKey}
            renderMobile={(r) => <MobileAccrualRow r={r} />}
          />
        ))}
    </section>
  );
}
