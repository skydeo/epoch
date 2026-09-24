// The Planner (route /projection): "if I take this trip, where am I on date X?"
//
// Pick a target date, optionally sketch a what-if trip (never saved until you
// press "Save as trip"), and see the balance on that date with and without it,
// the lowest point along the way, cap headroom, the next Jan 1 rollover, and
// personal-holiday hours left. All math is server-side (GET /api/projection).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { SegmentedControl } from "../components/SegmentedControl";
import { useToast } from "../components/Toast";
import { Button, Field, inputCls } from "../components/ui";
import { ErrorState, Spinner } from "../components/states";
import { ApiError, api, queryKeys } from "../lib/api";
import { addDays, addMonths, fmtLong, fmtShort, todayIso } from "../lib/date";
import { fmtG } from "../lib/format";
import type { BookingType, ProjectionParams, ProjectionResponse, UsageTypeValue } from "../types";

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

const cardCls =
  "rounded-[14px] border border-line bg-surface p-3 min-[900px]:rounded-card min-[900px]:p-[18px]";

function Chip({ onClick, children, disabled }: { onClick: () => void; children: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-8 rounded-pill border border-line bg-surface px-3 text-[13px] font-semibold text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Tile({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="min-w-0 rounded-[10px] bg-surface-2 px-2.5 py-2 min-[900px]:rounded-tile min-[900px]:px-3.5 min-[900px]:py-3">
      <div className="text-[11.5px] text-ink-3 min-[900px]:text-[12.5px]">{label}</div>
      <div
        className="font-display text-[17px] font-semibold tabular-nums min-[900px]:text-[22px]"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub && <div className="truncate text-[11.5px] text-ink-3 min-[900px]:text-[12.5px]">{sub}</div>}
    </div>
  );
}

// Balance from today's period to the target's: the what-if line solid, the
// no-trip line dashed. Drawn in a 0–100 viewBox stretched to the box; strokes
// stay crisp via non-scaling-stroke and the low-point dot is HTML so it stays
// round.
function BalanceSpark({ data }: { data: ProjectionResponse }) {
  const pts = data.series;
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const values = pts.flatMap((p) => [p.baseline, p.scenario]);
    const lo = Math.min(0, ...values);
    const hi = Math.max(...values, 1) * 1.08;
    const x = (i: number) => (i / (pts.length - 1)) * 100;
    const y = (v: number) => 96 - ((v - lo) / (hi - lo)) * 90;
    const line = (key: "baseline" | "scenario") =>
      pts.map((p, i) => `${x(i).toFixed(2)},${y(p[key]).toFixed(2)}`).join(" ");
    let trip: { x0: number; x1: number } | null = null;
    if (data.whatif && data.whatif.days > 0) {
      const idx = pts
        .map((p, i) => ({ i, end: p.end }))
        .filter(({ end }) => end >= data.whatif!.start);
      const first = idx[0]?.i;
      const last = pts.findIndex((p) => p.end >= data.whatif!.end);
      if (first !== undefined) {
        const stop = last === -1 ? pts.length - 1 : last;
        const half = 50 / (pts.length - 1);
        trip = { x0: Math.max(0, x(first) - half), x1: Math.min(100, x(stop) + half) };
      }
    }
    const lowIdx = data.lowest ? pts.findIndex((p) => p.end === data.lowest!.end) : -1;
    return {
      base: line("baseline"),
      scen: line("scenario"),
      zero: lo < 0 ? y(0) : null,
      trip,
      low: lowIdx >= 0 ? { x: x(lowIdx), y: y(pts[lowIdx].scenario) } : null,
      differs: pts.some((p) => p.baseline !== p.scenario),
    };
  }, [pts, data.whatif, data.lowest]);

  if (!geo) return null;
  const jan1 = pts.findIndex((p) => p.end.slice(5) < "01-15" && p.end.slice(5) >= "01-01");
  return (
    <div>
      <div className="relative h-[96px] min-[900px]:h-[200px]">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full overflow-visible"
          role="img"
          aria-label="Projected balance from today to the target date"
        >
          {geo.trip && (
            <rect
              x={geo.trip.x0}
              y="0"
              width={geo.trip.x1 - geo.trip.x0}
              height="100"
              fill="var(--danger)"
              opacity="0.12"
            />
          )}
          <line x1="0" y1="96" x2="100" y2="96" stroke="var(--border)" vectorEffect="non-scaling-stroke" />
          {geo.zero !== null && (
            <line x1="0" y1={geo.zero} x2="100" y2={geo.zero} stroke="var(--danger)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
          {geo.differs && (
            <polyline
              points={geo.base}
              fill="none"
              stroke="var(--text-3)"
              strokeWidth="1.6"
              strokeDasharray="4 4"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <polyline
            points={geo.scen}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {geo.low && geo.differs && (
          <span
            className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-surface"
            style={{ left: `${geo.low.x}%`, top: `${geo.low.y}%` }}
          />
        )}
      </div>
      <div className="mt-1 flex text-[11.5px] text-ink-3">
        <span>Today</span>
        <span className="flex-1" />
        {jan1 > 0 && jan1 < pts.length - 1 && (
          <>
            <span>Jan 1</span>
            <span className="flex-1" />
          </>
        )}
        <span>{fmtShort(data.target)}</span>
      </div>
    </div>
  );
}

export function Projection() {
  const qc = useQueryClient();
  const toast = useToast();
  const today = todayIso();

  // Inputs update immediately; the query params lag ~200ms so scrubbing a
  // date picker doesn't refetch per keystroke.
  const [target, setTarget] = useState(() => addMonths(today, 3));
  const [tripStart, setTripStart] = useState("");
  const [tripEnd, setTripEnd] = useState("");
  const [tripType, setTripType] = useState<UsageTypeValue>("pto");
  const [tripName, setTripName] = useState("");
  const [phFirst, setPhFirst] = useState(false);
  const booking: BookingType = tripType === "pto" && phFirst ? "ph_first" : tripType;
  const [includePlanned, setIncludePlanned] = useState(true);

  const hasTrip = !!tripStart && !!tripEnd;
  const draft: ProjectionParams = useMemo(
    () => ({
      date: target || undefined,
      ...(hasTrip ? { whatif_start: tripStart, whatif_end: tripEnd, whatif_type: booking } : {}),
      include_planned: includePlanned,
    }),
    [target, hasTrip, tripStart, tripEnd, booking, includePlanned],
  );
  const [params, setParams] = useState(draft);
  useEffect(() => {
    const t = window.setTimeout(() => setParams(draft), 200);
    return () => window.clearTimeout(t);
  }, [draft]);

  const query = useQuery<ProjectionResponse>({
    queryKey: queryKeys.projection(params),
    queryFn: () => api.projection(params),
    retry: false,
    placeholderData: (prev) => prev,
  });
  const data = query.data;

  const clearTrip = () => {
    setTripStart("");
    setTripEnd("");
    setTripName("");
    setTripType("pto");
  };

  const save = useMutation({
    mutationFn: () =>
      api.createUsage({
        start: tripStart,
        end: tripEnd,
        type: booking,
        reason: tripName,
        requested: false,
      }),
    onSuccess: (res) => {
      const hours = res.created.reduce((s, e) => s + e.hours, 0);
      toast.success(`Saved ${tripName.trim() || "trip"} · ${fmtG(hours)} h. Enjoy the time off.`);
      clearTrip();
      for (const key of ["usage", "dashboard", "chart", "accruals", "stats", "projection"])
        qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not save the trip."),
  });

  const whatif = data?.whatif ?? null;
  const tripDays = whatif && hasTrip ? whatif : null;
  const hpd = data?.hours_per_day ?? 8;
  const targetYear = (data?.target ?? target).slice(0, 4);
  const lostAtRollover = data?.rollover.lost ?? 0;

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Planner"
        blurb="Pick a date, sketch a trip, and see where your balance lands."
      />

      <div className="flex flex-col gap-2.5 min-[900px]:grid min-[900px]:grid-cols-[380px_minmax(0,1fr)] min-[900px]:items-start min-[900px]:gap-[22px]">
        {/* ===== Inputs ===== */}
        <div className="flex flex-col gap-2.5 min-[900px]:gap-3.5">
          <section className={`${cardCls} flex flex-col gap-2.5`}>
            <Field label="Where will I be on">
              <input
                type="date"
                className={`${inputCls} font-display text-[16px] font-semibold`}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              <Chip onClick={() => setTarget(addMonths(today, 1))}>+1 mo</Chip>
              <Chip onClick={() => setTarget(addMonths(today, 3))}>+3 mo</Chip>
              <Chip onClick={() => setTarget(addMonths(today, 6))}>+6 mo</Chip>
              <Chip onClick={() => setTarget(`${today.slice(0, 4)}-12-31`)}>Dec 31</Chip>
              <Chip onClick={() => setTarget(addDays(tripEnd, 1))} disabled={!tripEnd}>
                After trip
              </Chip>
            </div>
          </section>

          <section className={`${cardCls} flex flex-col gap-2.5`}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[14px] font-bold">What-if trip</span>
              <span className="text-[12px] text-ink-3">not saved</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="First day">
                <input
                  type="date"
                  className={`${inputCls} min-w-0`}
                  value={tripStart}
                  onChange={(e) => {
                    setTripStart(e.target.value);
                    if (!tripEnd || e.target.value > tripEnd) setTripEnd(e.target.value);
                  }}
                />
              </Field>
              <Field label="Last day">
                <input
                  type="date"
                  className={`${inputCls} min-w-0`}
                  value={tripEnd}
                  min={tripStart || undefined}
                  onChange={(e) => setTripEnd(e.target.value)}
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <SegmentedControl
                segments={[
                  { value: "pto", label: "PTO" },
                  { value: "personal_holiday", label: "PH" },
                ]}
                value={tripType}
                onChange={setTripType}
                ariaLabel="Trip type"
              />
              <div className="text-[12.5px] leading-snug text-ink-2">
                {tripDays ? (
                  <>
                    <span className="font-display font-bold text-ink">
                      {tripDays.days} workday{tripDays.days === 1 ? "" : "s"} · {fmtG(tripDays.hours)} h
                    </span>
                    {tripDays.type === "ph_first" && (
                      <>
                        <br />
                        {fmtG(tripDays.ph_hours)} h PH + {fmtG(tripDays.pto_hours)} h PTO
                      </>
                    )}
                    {tripDays.skipped_holidays.length > 0 && (
                      <>
                        <br />
                        skips{" "}
                        {tripDays.skipped_holidays
                          .map((d) => fmtShort(d, { year: false }))
                          .join(" and ")}
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-ink-3">Pick dates to try a trip.</span>
                )}
              </div>
            </div>
            {tripType === "pto" && (
              <label className="flex min-h-9 items-center gap-2.5 text-[13.5px] text-ink-2">
                <input
                  type="checkbox"
                  className="h-[18px] w-[18px] accent-primary"
                  checked={phFirst}
                  onChange={(e) => setPhFirst(e.target.checked)}
                />
                <span>Use personal holidays first, then PTO</span>
              </label>
            )}
            {hasTrip && (
              <Field label="Name (for saving)">
                <input
                  type="text"
                  className={inputCls}
                  placeholder="e.g. Winter break"
                  value={tripName}
                  onChange={(e) => setTripName(e.target.value)}
                />
              </Field>
            )}
            <label className="flex min-h-9 items-center gap-2.5 text-[13.5px] text-ink-2">
              <input
                type="checkbox"
                className="h-[18px] w-[18px] accent-primary"
                checked={includePlanned}
                onChange={(e) => setIncludePlanned(e.target.checked)}
              />
              <span>
                Count my planned time off
                {data && data.planned_hours > 0 && (
                  <span className="text-ink-3"> ({fmtG(data.planned_hours)} h)</span>
                )}
              </span>
            </label>
            {hasTrip && (
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  disabled={!tripDays || tripDays.days === 0 || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? "Saving…" : "Save as trip"}
                </Button>
                <Button variant="secondary" onClick={clearTrip}>
                  Clear
                </Button>
              </div>
            )}
          </section>
        </div>

        {/* ===== Result ===== */}
        <section aria-label="Result" className={`${cardCls} flex flex-col gap-3`}>
          {query.isPending && <Spinner label="Projecting…" />}
          {query.isError && !data && (
            <ErrorState message={projectionError(query.error)} onRetry={() => query.refetch()} />
          )}
          {data && (
            <>
              {query.isError && (
                <div role="alert" className="rounded-field bg-danger-soft px-3 py-2 text-[13px] font-medium text-danger">
                  {projectionError(query.error)}
                </div>
              )}
              <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
                <div className="flex-1">
                  <div className="text-[13px] text-ink-2">PTO balance on {fmtLong(data.target)}</div>
                  <div
                    className="font-display text-[40px] font-bold leading-[1.05] tracking-[-0.02em] tabular-nums min-[900px]:text-[52px]"
                    style={{ color: data.balance_negative ? "var(--danger)" : undefined }}
                  >
                    {fmtG(data.snap.pto_balance)}
                    <span className="text-[18px] font-medium text-ink-3 min-[900px]:text-[22px]"> h</span>
                  </div>
                  <div className="text-[12.5px] text-ink-3">
                    ≈ {fmtG(Math.max(0, data.snap.pto_balance) / hpd)} days you could take then
                  </div>
                </div>
                {whatif && whatif.days > 0 && (
                  <div className="text-right text-[12.5px] leading-snug text-ink-3">
                    without trip
                    <br />
                    <span className="font-display text-[15px] font-semibold text-ink-2">
                      {fmtG(data.baseline_balance)} h
                    </span>
                  </div>
                )}
              </div>

              <BalanceSpark data={data} />

              <div className="grid grid-cols-2 gap-2 min-[900px]:grid-cols-4 min-[900px]:gap-3">
                <Tile
                  label="Lowest point"
                  value={data.lowest ? `${fmtG(data.lowest.balance)} h` : "—"}
                  sub={data.lowest ? `period ending ${fmtShort(data.lowest.end, { year: false })}` : undefined}
                  color={data.lowest && data.lowest.balance < 0 ? "var(--danger)" : undefined}
                />
                <Tile
                  label="Room below cap"
                  value={`${fmtG(data.headroom)} h`}
                  sub={`cap ${fmtG(data.cap)} h`}
                  color={data.headroom <= 0 ? "var(--warn)" : undefined}
                />
                <Tile
                  label={`Lost at ${fmtShort(data.rollover.date)} rollover`}
                  value={`${fmtG(lostAtRollover)} h`}
                  sub={
                    lostAtRollover > 0
                      ? `use ${fmtG(lostAtRollover)} h more by Dec 31`
                      : `carryover limit ${fmtG(data.rollover_limit)} h`
                  }
                  color={lostAtRollover > 0 ? "var(--warn)" : "var(--mint)"}
                />
                <Tile
                  label={`Personal holiday ${targetYear}`}
                  value={`${fmtG(data.snap.ph_remaining)} h left`}
                  sub={`use by Dec 31`}
                  color="var(--warn)"
                />
              </div>

              {data.warnings.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {data.warnings.map((w) => (
                    <li
                      key={w}
                      className="flex items-start gap-2 rounded-[10px] bg-warn-soft px-2.5 py-2 text-[13px] leading-snug text-warn"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" className="mt-px flex-none">
                        <path d="M12 3l10 18H2z" />
                        <path d="M12 10v5M12 18v.5" />
                      </svg>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
