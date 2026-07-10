import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { DataTable, type Column, type RowState } from "../components/DataTable";
import { Badge, Button, Field, inputCls } from "../components/ui";
import { EmptyState, ErrorState, Spinner } from "../components/states";
import { api, queryKeys } from "../lib/api";
import { fmt2, fmtG, fmtChartLabel, fmtMonthDay } from "../lib/format";
import type { AccrualRow } from "../types";

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

export function Accruals() {
  // "all" → no year filter; otherwise a specific calendar year.
  const [year, setYear] = useState<number | "all">("all");
  // Newest period first by default (current data at the top).
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const query = useQuery({
    queryKey: queryKeys.accruals(year === "all" ? undefined : year),
    queryFn: () => api.accruals(year === "all" ? undefined : year),
  });

  // Rows arrive ascending by period index; reverse for descending.
  const rows = useMemo(() => {
    const base = query.data?.rows ?? [];
    return sortDir === "asc" ? base : [...base].reverse();
  }, [query.data, sortDir]);

  // Auto-scroll the current period into view on load (block:center). With the
  // default descending sort the current period sits near the top, so this is
  // nearly a no-op — but it keeps ascending-mode behavior correct.
  const scrollToKey = useMemo(() => {
    const cur = rows.find((r) => r.is_current);
    return cur ? cur.index : null;
  }, [rows]);

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Accruals"
        blurb="One row per pay period — accrued on the fly from the rules, never stored."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3.5">
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
        <div className="ml-auto flex flex-wrap items-center gap-4">
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
          />
        ))}
    </section>
  );
}
