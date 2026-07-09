import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { StatCard, type StatCardProps } from "../components/StatCard";
import { ErrorState, Spinner } from "../components/states";
import { api, queryKeys } from "../lib/api";
import { fmt2, fmtG, fmtLongDate, fmtMonthDay } from "../lib/format";
import type { DashboardStats } from "../types";
import { BalanceChart } from "./BalanceChart";

function buildCards(d: DashboardStats): StatCardProps[] {
  return [
    {
      label: "Current PTO Balance",
      value: fmt2(d.current_balance),
      sub: "hours · period in progress",
      iconColor: "var(--primary)",
      iconBg: "var(--primary-soft)",
      iconShape: "circle",
      valueColor: d.current_balance_negative ? "var(--danger)" : "var(--text)",
    },
    {
      label: "PH Remaining",
      value: fmtG(d.ph_remaining),
      sub: `of ${fmtG(d.ph_granted)} h granted · ${d.year}`,
      iconColor: "var(--mint)",
      iconBg: "var(--teal-soft)",
    },
    {
      label: "Max Balance Ever",
      value: fmt2(d.max_balance),
      sub: "peak accrued to date",
      iconColor: "var(--teal)",
      iconBg: "var(--teal-soft)",
      iconShape: "circle",
    },
    {
      label: "% of Cap",
      value: `${Math.round(d.pct_of_cap)}%`,
      sub: `of ${fmtG(d.cap)} h cap`,
      iconColor: "var(--warn)",
      iconBg: "var(--warn-soft)",
    },
    {
      label: "PTO Used YTD",
      value: fmtG(d.pto_used_ytd),
      sub: `hours in ${d.year}`,
      iconColor: "var(--danger)",
      iconBg: "var(--danger-soft)",
    },
    {
      label: "Next Pay Date",
      value: d.next_pay_date ? fmtMonthDay(d.next_pay_date) : "—",
      sub: `+${fmtG(d.next_pay_accrual)} h accrual`,
      iconColor: "var(--primary)",
      iconBg: "var(--primary-soft)",
      iconShape: "circle",
    },
  ];
}

export function Dashboard() {
  const query = useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: api.dashboard,
  });

  const today = fmtLongDate(new Date());

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Dashboard"
        blurb={`PTO accrual & usage as of ${today}.`}
        right={
          <span className="inline-flex items-center gap-2 rounded-xl bg-teal-soft px-3.5 py-2 text-[13px] font-semibold text-teal">
            <span className="h-2 w-2 rounded-full bg-teal" />
            Period in progress
          </span>
        }
      />

      {query.isPending && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <Spinner label="Loading dashboard…" />
        </div>
      )}

      {query.isError && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <ErrorState
            message="Could not load dashboard stats."
            onRetry={() => query.refetch()}
          />
        </div>
      )}

      {query.data && (
        <>
          {query.data.warnings.length > 0 && (
            <div className="mb-[22px] flex flex-col gap-2">
              {query.data.warnings.map((w, i) => (
                <div
                  key={i}
                  role="alert"
                  className="rounded-field border border-warn bg-warn-soft px-3.5 py-2.5 text-[13px] font-medium text-warn"
                >
                  {w}
                </div>
              ))}
            </div>
          )}

          <div className="mb-[22px] grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3.5 min-[900px]:grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))]">
            {buildCards(query.data).map((c) => (
              <StatCard key={c.label} {...c} />
            ))}
          </div>
        </>
      )}

      <BalanceChart />
    </section>
  );
}
