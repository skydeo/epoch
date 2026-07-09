import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { DataTable, type Column, type RowState } from "../components/DataTable";
import { EmptyState, ErrorState, Spinner } from "../components/states";
import { ApiError, api, queryKeys } from "../lib/api";
import { fmt2, fmtG, fmtMonthDay, fmtChartLabel } from "../lib/format";
import type { ProjectionResponse, YearStat } from "../types";

const todayIso = () => new Date().toISOString().slice(0, 10);

// Pull the human message out of a 400 { detail: { error } } body (apiFetch keeps
// the raw body on ApiError; the detail here is an object, not a plain string).
function projectionError(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (detail && typeof detail === "object" && "error" in detail) {
      return String((detail as { error: unknown }).error);
    }
    return err.message;
  }
  return "Could not compute the projection.";
}

function Tile({
  label,
  value,
  sub,
  color = "var(--text)",
}: {
  label: string;
  value: string;
  sub: string;
  color?: string;
}) {
  return (
    <div className="rounded-tile border border-line bg-surface-2 p-4">
      <div className="mb-2 text-xs font-semibold text-ink-2">{label}</div>
      <div
        className="font-display text-[27px] font-bold tabular-nums"
        style={{ color }}
      >
        {value}
      </div>
      <div className="mt-1.5 text-xs text-ink-3">{sub}</div>
    </div>
  );
}

// --- Per-year stats table (shared grid pattern via DataTable) ---

function UsedYearCell({ value }: { value: number }) {
  if (!value)
    return <span className="font-display tabular-nums text-ink-3">·</span>;
  return (
    <span className="font-display tabular-nums text-danger">{fmtG(value)}</span>
  );
}

const STATS_COLUMNS: Column<YearStat>[] = [
  {
    key: "year",
    header: "Year",
    render: (y) => (
      <span className="font-display font-bold">{y.year}</span>
    ),
  },
  {
    key: "accrued",
    header: "Accrued",
    align: "right",
    render: (y) => (
      <span className="font-display tabular-nums text-ink-2">
        {fmt2(y.accrued)}
      </span>
    ),
  },
  {
    key: "pto",
    header: "PTO used",
    align: "right",
    render: (y) => (
      <span className="font-display tabular-nums text-ink-2">
        {y.pto_used ? fmtG(y.pto_used) : "·"}
      </span>
    ),
  },
  {
    key: "ph",
    header: "PH used",
    align: "right",
    render: (y) => (
      <span className="font-display tabular-nums text-ink-2">
        {y.ph_used ? fmtG(y.ph_used) : "·"}
      </span>
    ),
  },
  {
    key: "cap",
    header: "Lost·cap",
    align: "right",
    render: (y) => <UsedYearCell value={y.lost_to_cap} />,
  },
  {
    key: "roll",
    header: "Lost·roll",
    align: "right",
    render: (y) => <UsedYearCell value={y.lost_to_rollover} />,
  },
];

export function Projection() {
  // Immediate input value; the *query* date lags by ~150ms so typing/scrubbing
  // the picker doesn't refetch on every keystroke (HANDOFF §7).
  const [dateInput, setDateInput] = useState(todayIso());
  const [queryDate, setQueryDate] = useState(todayIso());

  useEffect(() => {
    const t = window.setTimeout(() => setQueryDate(dateInput), 150);
    return () => window.clearTimeout(t);
  }, [dateInput]);

  const query = useQuery<ProjectionResponse>({
    queryKey: queryKeys.projection(queryDate),
    queryFn: () => api.projection(queryDate),
    retry: false,
    placeholderData: (prev) => prev,
  });

  const stats = useQuery({
    queryKey: queryKeys.stats(),
    queryFn: () => api.stats(),
  });

  const data = query.data;
  const targetYear = Number((data?.target ?? queryDate).slice(0, 4));
  const currentYear = data ? Number(data.today.slice(0, 4)) : new Date().getFullYear();

  const tag = !data
    ? ""
    : data.target === data.today
      ? "TODAY"
      : data.is_future
        ? "FUTURE"
        : "PAST";

  const rowState = (y: YearStat): RowState =>
    y.year === currentYear ? "current" : y.year > currentYear ? "future" : "past";

  const scrollToKey = useMemo(
    () => stats.data?.years.find((y) => y.year === currentYear)?.year ?? null,
    [stats.data, currentYear],
  );

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Projection"
        blurb="Pick any date — past or future — to see the projected PTO balance and any hours forfeited between now and then."
      />

      <div className="mb-[18px] flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5 text-xs font-semibold text-ink-2">
          Projection date
          <input
            type="date"
            className="rounded-field border border-line bg-bg-elev px-3 py-[9px] text-[13.5px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary"
            value={dateInput}
            onChange={(e) => setDateInput(e.target.value)}
          />
        </label>
        {tag && (
          <span className="inline-flex items-center rounded-pill bg-primary-soft px-3.5 py-1.5 text-[11.5px] font-bold tracking-[0.05em] text-primary">
            {tag}
          </span>
        )}
      </div>

      {/* ===== Snapshot card ===== */}
      <article className="mb-[26px] rounded-card border border-line bg-surface p-[22px] shadow-[var(--shadow)]">
        <div className="mb-4 font-display text-base font-bold">
          Projected balance on {queryDate}
        </div>

        {query.isError ? (
          <div className="rounded-field border border-danger bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger">
            {projectionError(query.error)}
          </div>
        ) : !data ? (
          <Spinner label="Computing projection…" />
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3.5">
              <Tile
                label="Projected PTO balance"
                value={fmt2(data.snap.pto_balance)}
                sub="hours · pay period containing date"
                color={data.balance_negative ? "var(--danger)" : "var(--primary)"}
              />
              <Tile
                label="Containing pay period"
                value={`${fmtMonthDay(data.period_start)} – ${fmtMonthDay(data.period_end)}`}
                sub={`pay date ${fmtChartLabel(data.period_pay)}`}
              />
              <Tile
                label={`PH remaining ${targetYear}`}
                value={fmtG(data.snap.ph_remaining)}
                sub={`${fmtG(data.snap.ph_used)} of ${fmtG(data.snap.ph_granted)} h used`}
                color="var(--text)"
              />
            </div>

            {(() => {
              const notes = data.warnings.length
                ? data.warnings
                : data.snap.warnings;
              const hasNotes = notes.length > 0;
              return (
                <div
                  className="mt-4 rounded-[12px] border px-3.5 py-3 text-[13px] leading-[1.5]"
                  style={
                    hasNotes
                      ? {
                          background: "var(--warn-soft)",
                          color: "var(--warn)",
                          borderColor: "var(--warn)",
                        }
                      : {
                          background: "var(--surface-2)",
                          color: "var(--text-3)",
                          borderColor: "var(--border)",
                        }
                  }
                >
                  {hasNotes
                    ? notes.join(" ")
                    : "No hours forfeited to the cap or year-end rollover in this window."}
                </div>
              );
            })()}

            <p className="mt-3 text-xs text-ink-3">
              The balance reflects the pay period containing the selected date —
              accruals post per period, not per day.
            </p>
          </>
        )}
      </article>

      {/* ===== Per-year stats ===== */}
      <h2 className="mb-1 font-display text-lg font-semibold">Per-year stats</h2>
      <p className="mb-3.5 max-w-[70ch] text-[12.5px] text-ink-3">
        Accrual, usage, and forfeitures grouped by calendar year. Future years
        are projected from the accrual rules assuming no further usage.
      </p>

      {stats.isPending && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <Spinner label="Loading stats…" />
        </div>
      )}
      {stats.isError && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <ErrorState
            message="Could not load the per-year stats."
            onRetry={() => stats.refetch()}
          />
        </div>
      )}
      {stats.data &&
        (stats.data.years.length === 0 ? (
          <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
            <EmptyState message="No yearly stats yet." />
          </div>
        ) : (
          <DataTable
            ariaLabel="Per-year stats"
            columns={STATS_COLUMNS}
            rows={stats.data.years}
            rowKey={(y) => y.year}
            rowState={rowState}
            gridTemplate="minmax(90px,1fr) 100px 96px 84px 84px 84px"
            minWidth={560}
            scrollToKey={scrollToKey}
          />
        ))}
    </section>
  );
}
