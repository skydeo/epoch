import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { DataTable, type Column } from "../components/DataTable";
import { RowMenu } from "../components/RowMenu";
import { SegmentedControl } from "../components/SegmentedControl";
import { Badge, Button, Field, inputCls } from "../components/ui";
import { EmptyState, ErrorState, Spinner } from "../components/states";
import { ApiError, api, queryKeys, type UsageFilters } from "../lib/api";
import { fmtRange, parseIso, todayIso } from "../lib/date";
import { useIsMobile } from "../lib/useMediaQuery";
import { fmtG } from "../lib/format";
import type { Trip, UsageEntry, UsageResponse, UsageTypeValue } from "../types";

const editInputCls =
  "rounded-field border border-line bg-bg-elev px-2 py-1.5 text-[13px] text-ink " +
  "outline-none w-full min-w-0 focus-visible:ring-2 focus-visible:ring-primary";


// The usage list lives under the "usage" query-key prefix (one cache entry per
// filter combo). Optimistic mutations update every matching entry at once.
const USAGE_ROOT = { queryKey: ["usage"] as const };

// A trip's identity across refetches: type + start + reason survive a requested
// toggle (ids do too, but this reads clearer for the expand set).
const tripKey = (t: Trip) => `${t.type}|${t.start}|${t.reason ?? ""}`;

interface EditDraft {
  date: string;
  hours: string;
  type: UsageTypeValue;
  reason: string;
}

const DAY_GRID = "110px 64px 140px minmax(120px,1fr) 96px 150px";

export function Usage() {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  // Mobile keeps the add form and filters folded away until asked for.
  const [addOpen, setAddOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Trips | Days — trips is the default mental model (a range is one trip).
  const [view, setView] = useState<"trips" | "days">("trips");

  // --- Filters drive the query params (HANDOFF §7) ---
  const [type, setType] = useState<"" | UsageTypeValue>("");
  const [yearFilter, setYearFilter] = useState<"" | number>("");
  const [requested, setRequested] = useState<"" | "true" | "false">("");
  // Newest first by default (current data at the top): days by date, trips by
  // start date.
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filters: UsageFilters = useMemo(
    () => ({
      type: type || undefined,
      year: yearFilter === "" ? undefined : yearFilter,
      requested: requested === "" ? undefined : requested === "true",
    }),
    [type, yearFilter, requested],
  );

  const query = useQuery({
    queryKey: queryKeys.usage(filters as Record<string, unknown>),
    queryFn: () => api.usage(filters),
  });

  // Rows arrive ascending by (date, id); flip for descending.
  const rows = useMemo(() => {
    const base = query.data?.rows ?? [];
    const sorted = [...base].sort(
      (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
    );
    return sortDir === "asc" ? sorted : sorted.reverse();
  }, [query.data, sortDir]);

  // Trips arrive ascending by start; flip for descending.
  const trips = useMemo(() => {
    const base = query.data?.trips ?? [];
    const sorted = [...base].sort(
      (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
    );
    return sortDir === "asc" ? sorted : sorted.reverse();
  }, [query.data, sortDir]);

  // --- Balance-rippling invalidation: a usage change shifts every downstream
  //     balance (dashboard cards, chart, accrual ledger). HANDOFF §7. ---
  const invalidateBalances = () => {
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["chart"] });
    qc.invalidateQueries({ queryKey: ["accruals"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
    qc.invalidateQueries({ queryKey: ["projection"] });
  };

  const snapshot = () => qc.getQueriesData<UsageResponse>(USAGE_ROOT);
  const restore = (prev: ReturnType<typeof snapshot> | undefined) =>
    prev?.forEach(([key, data]) => qc.setQueryData(key, data));

  // Update just the flat `rows` of every cached usage response.
  const patchCache = (fn: (rows: UsageEntry[]) => UsageEntry[]) => {
    qc.setQueriesData<UsageResponse>(USAGE_ROOT, (old) =>
      old ? { ...old, rows: fn(old.rows) } : old,
    );
  };
  // Update the whole cached usage response (rows AND grouped trips), used by
  // trip-level bulk mutations so the grouped view stays consistent optimistically.
  const patchUsage = (fn: (data: UsageResponse) => UsageResponse) => {
    qc.setQueriesData<UsageResponse>(USAGE_ROOT, (old) => (old ? fn(old) : old));
  };

  // --- Toggle "requested" for one day (optimistic) ---
  const toggle = useMutation({
    mutationFn: (v: { id: number; requested: boolean }) =>
      api.patchUsage(v.id, { requested: v.requested }),
    onMutate: async ({ id, requested }) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      patchUsage((data) => ({
        ...data,
        rows: data.rows.map((r) => (r.id === id ? { ...r, requested } : r)),
        trips: reflagTrips(data.trips, [id], requested),
      }));
      return { prev };
    },
    onError: (_e, _v, ctx) => restore(ctx?.prev),
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      qc.invalidateQueries({ queryKey: ["projection"] });
    },
  });

  // --- Delete one day (optimistic) ---
  const del = useMutation({
    mutationFn: (id: number) => api.deleteUsage(id),
    onMutate: async (id) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      patchUsage((data) => removeIds(data, [id]));
      return { prev };
    },
    onError: (_e, _id, ctx) => restore(ctx?.prev),
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      invalidateBalances();
    },
  });

  // --- Inline edit one day (optimistic) ---
  const patch = useMutation({
    mutationFn: (v: {
      id: number;
      body: { date: string; hours: number; type: UsageTypeValue; reason: string };
    }) => api.patchUsage(v.id, v.body),
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      patchCache((rows) =>
        rows.map((r) =>
          r.id === id
            ? { ...r, ...body, reason: body.reason.trim() || null }
            : r,
        ),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => restore(ctx?.prev),
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      invalidateBalances();
    },
  });

  // --- Toggle "requested" for a whole trip (bulk PATCH, optimistic) ---
  const bulkToggle = useMutation({
    mutationFn: (v: { ids: number[]; requested: boolean }) =>
      api.bulkPatchUsage({ ids: v.ids, requested: v.requested }),
    onMutate: async ({ ids, requested }) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      const idSet = new Set(ids);
      patchUsage((data) => ({
        ...data,
        rows: data.rows.map((r) =>
          idSet.has(r.id) ? { ...r, requested } : r,
        ),
        trips: reflagTrips(data.trips, ids, requested),
      }));
      return { prev };
    },
    onError: (_e, _v, ctx) => restore(ctx?.prev),
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      qc.invalidateQueries({ queryKey: ["projection"] });
    },
  });

  // --- Delete a whole trip (bulk delete, optimistic) ---
  const tripDelete = useMutation({
    mutationFn: (ids: number[]) => api.bulkDeleteUsage(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      patchUsage((data) => removeIds(data, ids));
      return { prev };
    },
    onError: (_e, _ids, ctx) => restore(ctx?.prev),
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      invalidateBalances();
    },
  });

  // --- Add a range (server expands to per-day rows) ---
  const [form, setForm] = useState({
    start: todayIso(),
    end: todayIso(),
    type: "pto" as UsageTypeValue,
    reason: "",
    requested: false,
  });
  const add = useMutation({
    mutationFn: () => api.createUsage(form),
    onSuccess: (data) => {
      // Merge the freshly created rows into every usage cache so the table
      // updates in place; the settle-invalidate reconciles filters/sort/trips.
      patchCache((rows) =>
        [...rows, ...data.created].sort(
          (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
        ),
      );
      // A new range is a new trip — land the user where they can see it.
      setView("trips");
      setAddOpen(false);
    },
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      invalidateBalances();
    },
  });

  const submitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    add.mutate();
  };

  // --- Inline edit state ---
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);

  const beginEdit = (r: UsageEntry) => {
    setEditingId(r.id);
    setDraft({
      date: r.date,
      hours: fmtG(r.hours),
      type: r.type,
      reason: r.reason ?? "",
    });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setDraft(null);
  };
  const saveEdit = (id: number) => {
    if (!draft) return;
    patch.mutate({
      id,
      body: {
        date: draft.date,
        hours: Number(draft.hours) || 0,
        type: draft.type,
        reason: draft.reason,
      },
    });
    cancelEdit();
  };

  // --- Expanded trips ---
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addError = add.error instanceof ApiError ? add.error.message : null;

  // Shared per-day columns — reused by the Days table and each expanded trip.
  const dayColumns: Column<UsageEntry>[] = useMemo(
    () => [
      {
        key: "date",
        header: "Date",
        render: (r) =>
          editingId === r.id && draft ? (
            <input
              type="date"
              className={editInputCls}
              value={draft.date}
              onChange={(e) =>
                setDraft((d) => d && { ...d, date: e.target.value })
              }
            />
          ) : (
            <span className="font-display font-semibold">{r.date}</span>
          ),
      },
      {
        key: "hours",
        header: "Hours",
        align: "right",
        render: (r) =>
          editingId === r.id && draft ? (
            <input
              type="number"
              step="0.5"
              className={editInputCls}
              value={draft.hours}
              onChange={(e) =>
                setDraft((d) => d && { ...d, hours: e.target.value })
              }
            />
          ) : (
            <span className="font-display tabular-nums text-ink-2">
              {fmtG(r.hours)}
            </span>
          ),
      },
      {
        key: "type",
        header: "Type",
        render: (r) => {
          if (editingId === r.id && draft)
            return (
              <select
                className={editInputCls}
                value={draft.type}
                onChange={(e) =>
                  setDraft(
                    (d) =>
                      d && { ...d, type: e.target.value as UsageTypeValue },
                  )
                }
              >
                <option value="pto">PTO</option>
                <option value="personal_holiday">Personal Holiday</option>
              </select>
            );
          return <TypePill type={r.type} />;
        },
      },
      {
        key: "reason",
        header: "Reason",
        render: (r) =>
          editingId === r.id && draft ? (
            <input
              type="text"
              className={editInputCls}
              placeholder="optional"
              value={draft.reason}
              onChange={(e) =>
                setDraft((d) => d && { ...d, reason: e.target.value })
              }
            />
          ) : (
            <span className="truncate text-ink-2">{r.reason || "—"}</span>
          ),
      },
      {
        key: "requested",
        header: "Requested",
        align: "center",
        render: (r) => (
          <RequestedPill
            requested={r.requested}
            onClick={() =>
              toggle.mutate({ id: r.id, requested: !r.requested })
            }
          />
        ),
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (r) => (
          <span className="flex gap-2">
            {editingId === r.id ? (
              <>
                <Button variant="primary" onClick={() => saveEdit(r.id)}>
                  Save
                </Button>
                <Button variant="ghost" onClick={cancelEdit}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => beginEdit(r)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`Delete ${r.date}?`)) del.mutate(r.id);
                  }}
                >
                  Delete
                </Button>
              </>
            )}
          </span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editingId, draft],
  );

  // Trip-level columns for the grouped view.
  const tripColumns: Column<Trip>[] = useMemo(
    () => [
      {
        key: "expand",
        header: "",
        label: "",
        render: (t) => {
          const open = expanded.has(tripKey(t));
          return (
            <button
              type="button"
              onClick={() => toggleExpanded(tripKey(t))}
              aria-expanded={open}
              aria-label={open ? "Collapse trip" : "Expand trip"}
              className="flex h-7 w-7 items-center justify-center rounded-field border border-line text-ink-2 hover:border-line-strong hover:text-ink"
            >
              <span
                className="transition-transform"
                style={{ transform: open ? "rotate(90deg)" : "none" }}
              >
                ›
              </span>
            </button>
          );
        },
      },
      {
        key: "range",
        header: "Dates",
        render: (t) => (
          <span className="font-display font-semibold">
            {t.start === t.end ? t.start : `${t.start} → ${t.end}`}
          </span>
        ),
      },
      {
        key: "size",
        header: "Days / Hours",
        align: "right",
        render: (t) => (
          <span className="font-display tabular-nums text-ink-2">
            {t.day_count} {t.day_count === 1 ? "day" : "days"} · {fmtG(t.total_hours)}h
          </span>
        ),
      },
      {
        key: "type",
        header: "Type",
        render: (t) => <TypePill type={t.type} />,
      },
      {
        key: "reason",
        header: "Reason",
        render: (t) => (
          <span className="truncate text-ink-2">{t.reason || "—"}</span>
        ),
      },
      {
        key: "requested",
        header: "Requested",
        align: "center",
        render: (t) => <TripRequestedBadge trip={t} />,
      },
      {
        key: "actions",
        header: "Actions",
        align: "right",
        render: (t) => {
          const allRequested = t.requested === "all";
          return (
            <span className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() =>
                  bulkToggle.mutate({ ids: t.ids, requested: !allRequested })
                }
              >
                {allRequested ? "Unrequest all" : "Request all"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  const label =
                    t.start === t.end ? t.start : `${t.start} → ${t.end}`;
                  if (
                    window.confirm(
                      `Delete this trip (${t.day_count} day${t.day_count === 1 ? "" : "s"}, ${label})?`,
                    )
                  )
                    tripDelete.mutate(t.ids);
                }}
              >
                Delete
              </Button>
            </span>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded],
  );

  // The per-day rows shown inside an expanded trip, sourced from the flat row
  // list so per-day edits/toggles/deletes stay live without re-grouping.
  const daysForTrip = (t: Trip) => {
    const ids = new Set(t.ids);
    const inTrip = (query.data?.rows ?? []).filter((r) => ids.has(r.id));
    return inTrip.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  };

  const today = todayIso();
  const upcomingTrips = trips.filter((t) => t.end >= today);
  const pastTrips = trips.filter((t) => t.end < today);
  const allRows = query.data?.rows ?? [];
  const ptoHours = allRows.filter((r) => r.type === "pto").reduce((n, r) => n + r.hours, 0);
  const phHours = allRows.filter((r) => r.type !== "pto").reduce((n, r) => n + r.hours, 0);
  const activeFilters =
    (type ? 1 : 0) + (yearFilter !== "" ? 1 : 0) + (requested ? 1 : 0);

  const confirmTripDelete = (t: Trip) => {
    if (
      window.confirm(
        `Delete this trip (${t.day_count} day${t.day_count === 1 ? "" : "s"}, ${fmtRange(t.start, t.end)})?`,
      )
    )
      tripDelete.mutate(t.ids);
  };

  const mobileTripRow = (t: Trip) => {
    const key = tripKey(t);
    const isPh = t.type === "personal_holiday";
    const allRequested = t.requested === "all";
    return (
      <div className="flex items-center gap-1 py-1 pl-3">
        <button
          type="button"
          onClick={() => toggleExpanded(key)}
          aria-expanded={expanded.has(key)}
          className="flex min-w-0 flex-1 flex-col gap-0.5 py-1 text-left"
        >
          <span className="flex items-center gap-[7px]">
            <span
              className="h-[9px] w-[9px] flex-none rounded-full"
              style={{ background: isPh ? "var(--warn)" : "var(--danger)" }}
            />
            <span className="truncate text-[15px] font-semibold text-ink">
              {t.reason || (isPh ? "Personal holiday" : "PTO")}
            </span>
            {isPh && t.reason && (
              <Badge color="var(--warn)" bg="var(--warn-soft)" className="text-[11px]">
                PH
              </Badge>
            )}
            <span className="flex-1" />
            <span className="font-display text-[16px] font-bold tabular-nums text-ink">
              {fmtG(t.total_hours)}
              <span className="text-[11.5px] font-medium text-ink-3"> h</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
            <span className="truncate">
              {fmtRange(t.start, t.end)}
              {t.start.slice(0, 4) !== today.slice(0, 4) && `, ${t.start.slice(0, 4)}`} · {t.day_count}{" "}
              {t.day_count === 1 ? "day" : "days"}
            </span>
            <span className="flex-1" />
            <TripRequestedBadge trip={t} />
          </span>
        </button>
        <RowMenu
          label="Trip actions"
          items={[
            {
              label: allRequested ? "Mark not requested" : "Mark requested",
              onSelect: () => bulkToggle.mutate({ ids: t.ids, requested: !allRequested }),
            },
            {
              label: expanded.has(key) ? "Hide days" : "Show days",
              onSelect: () => toggleExpanded(key),
            },
            { label: "Delete trip", danger: true, onSelect: () => confirmTripDelete(t) },
          ]}
        />
      </div>
    );
  };

  // One day, phone-sized. `inTrip` drops the type/reason already on the trip.
  const mobileDayRow = (r: UsageEntry, inTrip = false) => {
    if (editingId === r.id && draft)
      return (
        <div className="grid grid-cols-2 gap-2 px-3 py-2.5">
          <input
            type="date"
            aria-label="Date"
            className={editInputCls}
            value={draft.date}
            onChange={(e) => setDraft((d) => d && { ...d, date: e.target.value })}
          />
          <input
            type="number"
            step="0.5"
            aria-label="Hours"
            className={editInputCls}
            value={draft.hours}
            onChange={(e) => setDraft((d) => d && { ...d, hours: e.target.value })}
          />
          <select
            aria-label="Type"
            className={editInputCls}
            value={draft.type}
            onChange={(e) =>
              setDraft((d) => d && { ...d, type: e.target.value as UsageTypeValue })
            }
          >
            <option value="pto">PTO</option>
            <option value="personal_holiday">Personal Holiday</option>
          </select>
          <input
            type="text"
            aria-label="Reason"
            placeholder="reason"
            className={editInputCls}
            value={draft.reason}
            onChange={(e) => setDraft((d) => d && { ...d, reason: e.target.value })}
          />
          <div className="col-span-2 flex gap-2">
            <Button variant="primary" onClick={() => saveEdit(r.id)}>
              Save
            </Button>
            <Button variant="ghost" onClick={cancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      );
    const isPh = r.type === "personal_holiday";
    const date = parseIso(r.date).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(inTrip ? {} : { year: "numeric" }),
    });
    return (
      <div className={["flex items-center gap-2", inTrip ? "pl-7 pr-0" : "pl-3"].join(" ")}>
        {!inTrip && (
          <span
            className="h-[9px] w-[9px] flex-none rounded-full"
            style={{ background: isPh ? "var(--warn)" : "var(--danger)" }}
          />
        )}
        <span className="min-w-0 flex-1 truncate text-[13.5px]">
          <span className="font-display font-medium text-ink">{date}</span>
          {!inTrip && r.reason && <span className="text-ink-3"> · {r.reason}</span>}
        </span>
        <span className="font-display text-[14px] font-semibold tabular-nums">
          {fmtG(r.hours)} h
        </span>
        <button
          type="button"
          onClick={() => toggle.mutate({ id: r.id, requested: !r.requested })}
          aria-pressed={r.requested}
          aria-label={r.requested ? "Requested — tap to unmark" : "Not requested — tap to mark"}
          className="flex h-9 w-9 items-center justify-center"
        >
          <span
            className="flex h-[22px] w-[22px] items-center justify-center rounded-full border"
            style={{
              borderColor: r.requested ? "var(--mint)" : "var(--border-strong)",
              background: r.requested ? "var(--teal-soft)" : "transparent",
              color: "var(--mint)",
            }}
          >
            {r.requested && (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
            )}
          </span>
        </button>
        <RowMenu
          label="Day actions"
          items={[
            { label: "Edit", onSelect: () => beginEdit(r) },
            {
              label: "Delete",
              danger: true,
              onSelect: () => {
                if (window.confirm(`Delete ${r.date}?`)) del.mutate(r.id);
              },
            },
          ]}
        />
      </div>
    );
  };

  const tripTable = (list: Trip[], label: string) => (
    <DataTable
      ariaLabel={label}
      columns={tripColumns}
      rows={list}
      rowKey={(t) => tripKey(t)}
      gridTemplate="44px minmax(150px,1.2fr) 150px 140px minmax(120px,1fr) 120px 190px"
      minWidth={820}
      renderMobile={mobileTripRow}
      renderExpanded={(t) =>
        expanded.has(tripKey(t)) ? (
          isMobile ? (
            <div className="flex flex-col divide-y divide-dashed divide-line border-t border-dashed border-line">
              {daysForTrip(t).map((r) => (
                <div key={r.id}>{mobileDayRow(r, true)}</div>
              ))}
            </div>
          ) : (
            <DataTable
              ariaLabel={`Days in trip ${t.start}`}
              columns={dayColumns}
              rows={daysForTrip(t)}
              rowKey={(r) => r.id}
              gridTemplate={DAY_GRID}
              minWidth={700}
            />
          )
        ) : null
      }
    />
  );

  const sectionLabel = (text: string) => (
    <h2 className="mb-2 mt-1 px-0.5 text-[12px] font-bold uppercase tracking-[0.06em] text-ink-3">
      {text}
    </h2>
  );

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Usage"
        blurb="Log PTO and personal-holiday days. Adjacent days with the same reason group into one trip."
      />

      {/* ===== Mobile toolbar: view switch, filters, add ===== */}
      {isMobile && (
        <div className="mb-3 flex items-center gap-2">
          <SegmentedControl
            segments={[
              { value: "trips", label: "Trips" },
              { value: "days", label: "Days" },
            ]}
            value={view}
            onChange={setView}
            ariaLabel="Usage view"
          />
          <span className="flex-1" />
          <button
            type="button"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
            className="flex h-10 items-center gap-1.5 rounded-field border border-line bg-surface-2 px-3 text-[14px] font-semibold text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            Filter
            {activeFilters > 0 && (
              <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-pill bg-primary px-1 text-[11px] font-bold text-[var(--bg-elev)]">
                {activeFilters}
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={addOpen ? "Close add form" : "Add time off"}
            aria-expanded={addOpen}
            onClick={() => setAddOpen((o) => !o)}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-[var(--bg-elev)]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true" style={{ transform: addOpen ? "rotate(45deg)" : "none", transition: "transform .15s" }}>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      )}
      {isMobile && allRows.length > 0 && (
        <p className="mb-2 px-0.5 text-[12.5px] text-ink-2">
          <span className="font-display font-semibold text-danger">{fmtG(ptoHours)} h</span> PTO ·{" "}
          <span className="font-display font-semibold text-warn">{fmtG(phHours)} h</span> PH ·{" "}
          {upcomingTrips.length} upcoming, {pastTrips.length} taken
          {activeFilters === 0 && " · all years"}
        </p>
      )}

      {/* ===== Add range ===== */}
      {(!isMobile || addOpen) && (
      <form
        onSubmit={submitAdd}
        className="mb-4 grid grid-cols-2 items-end gap-2.5 rounded-tile border border-line bg-surface px-3 py-3 shadow-[var(--shadow-sm)] min-[900px]:flex min-[900px]:flex-wrap min-[900px]:gap-3 min-[900px]:px-[18px] min-[900px]:py-4"
      >
        <Field label="Start">
          <input
            type="date"
            required
            className={inputCls}
            value={form.start}
            onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
          />
        </Field>
        <Field label="End">
          <input
            type="date"
            required
            className={inputCls}
            value={form.end}
            onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
          />
        </Field>
        <Field label="Type">
          <select
            className={inputCls}
            value={form.type}
            onChange={(e) =>
              setForm((f) => ({ ...f, type: e.target.value as UsageTypeValue }))
            }
          >
            <option value="pto">PTO</option>
            <option value="personal_holiday">Personal Holiday</option>
          </select>
        </Field>
        <Field label="Reason" className="col-span-2 flex-1 basis-40">
          <input
            type="text"
            placeholder="optional"
            className={`${inputCls} w-full`}
            value={form.reason}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
          />
        </Field>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-semibold text-ink-2">
          <input
            type="checkbox"
            className="accent-primary"
            checked={form.requested}
            onChange={(e) =>
              setForm((f) => ({ ...f, requested: e.target.checked }))
            }
          />
          Requested
        </label>
        <Button type="submit" disabled={add.isPending}>
          {add.isPending ? "Adding…" : "Add days"}
        </Button>
      </form>
      )}

      {addError && (
        <div
          role="alert"
          className="mb-4 rounded-field border border-danger bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger"
        >
          {addError}
        </div>
      )}

      {/* ===== View switch + filters ===== */}
      {(!isMobile || filtersOpen) && (
      <div className="mb-4 grid grid-cols-2 items-end gap-2.5 min-[900px]:flex min-[900px]:flex-wrap min-[900px]:gap-3">
        <div className="hidden flex-col gap-1.5 text-xs font-semibold text-ink-2 min-[900px]:flex">
          View
          <SegmentedControl
            segments={[
              { value: "trips", label: "Trips" },
              { value: "days", label: "Days" },
            ]}
            value={view}
            onChange={setView}
            ariaLabel="Usage view"
          />
        </div>
        <Field label="Type">
          <select
            className={inputCls}
            value={type}
            onChange={(e) => setType(e.target.value as "" | UsageTypeValue)}
          >
            <option value="">All</option>
            <option value="pto">PTO</option>
            <option value="personal_holiday">Personal Holiday</option>
          </select>
        </Field>
        <Field label="Year">
          <select
            className={inputCls}
            value={yearFilter}
            onChange={(e) =>
              setYearFilter(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">All</option>
            {(query.data?.years ?? []).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Requested">
          <select
            className={inputCls}
            value={requested}
            onChange={(e) =>
              setRequested(e.target.value as "" | "true" | "false")
            }
          >
            <option value="">Any</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </Field>
        <div className="flex items-end">
          <Button
            variant="ghost"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            aria-label={`Sort by date ${sortDir === "asc" ? "descending" : "ascending"}`}
          >
            Date {sortDir === "asc" ? "↑" : "↓"}
          </Button>
        </div>
      </div>
      )}

      {query.isPending && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <Spinner label="Loading usage…" />
        </div>
      )}
      {query.isError && (
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <ErrorState
            message="Could not load the usage log."
            onRetry={() => query.refetch()}
          />
        </div>
      )}

      {query.data &&
        (query.data.rows.length === 0 ? (
          <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
            <EmptyState message="No usage entries match these filters." />
          </div>
        ) : view === "days" ? (
          <DataTable
            ariaLabel="Usage log"
            columns={dayColumns}
            rows={rows}
            rowKey={(r) => r.id}
            gridTemplate={DAY_GRID}
            minWidth={700}
            renderMobile={(r) => <div className="py-0.5">{mobileDayRow(r)}</div>}
          />
        ) : (
          <div className="flex flex-col gap-2">
            {upcomingTrips.length > 0 && (
              <div>
                {sectionLabel("Upcoming")}
                {tripTable(upcomingTrips, "Upcoming trips")}
              </div>
            )}
            {pastTrips.length > 0 && (
              <div>
                {sectionLabel("Taken")}
                {tripTable(pastTrips, "Past trips")}
              </div>
            )}
          </div>
        ))}
    </section>
  );
}

// --------------------------------------------------------------------------- //
// Small presentational + cache helpers
// --------------------------------------------------------------------------- //

function TypePill({ type }: { type: UsageTypeValue }) {
  const isPh = type === "personal_holiday";
  return (
    <Badge
      color={isPh ? "var(--warn)" : "var(--danger)"}
      bg={isPh ? "var(--warn-soft)" : "var(--danger-soft)"}
      className="text-[11.5px]"
    >
      {isPh ? "Personal Holiday" : "PTO"}
    </Badge>
  );
}

function RequestedPill({
  requested,
  onClick,
}: {
  requested: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-pill border px-3 py-1 text-xs font-semibold"
      style={{
        borderColor: requested ? "var(--mint)" : "var(--border)",
        background: requested ? "var(--teal-soft)" : "transparent",
        color: requested ? "var(--mint)" : "var(--text-3)",
      }}
      aria-pressed={requested}
    >
      {requested ? "✓ Yes" : "No"}
    </button>
  );
}

function TripRequestedBadge({ trip }: { trip: Trip }) {
  if (trip.requested === "all")
    return (
      <Badge color="var(--mint)" bg="var(--teal-soft)" className="text-[11.5px]">
        Requested
      </Badge>
    );
  if (trip.requested === "none")
    return (
      <Badge color="var(--text-3)" bg="var(--surface-2)" className="text-[11.5px]">
        Not requested
      </Badge>
    );
  const done = trip.days.filter((d) => d.requested).length;
  return (
    <Badge color="var(--warn)" bg="var(--warn-soft)" className="text-[11.5px]">
      {done} of {trip.day_count}
    </Badge>
  );
}

/** Set `requested` on the given day ids within each trip, recomputing its
 *  all/some/none tri-state so the grouped view stays consistent optimistically. */
function reflagTrips(
  trips: Trip[],
  ids: number[],
  requested: boolean,
): Trip[] {
  const idSet = new Set(ids);
  return trips.map((t) => {
    if (!t.ids.some((id) => idSet.has(id))) return t;
    const days = t.days.map((d) =>
      idSet.has(d.id) ? { ...d, requested } : d,
    );
    const flags = days.map((d) => d.requested);
    const tri = flags.every(Boolean)
      ? "all"
      : flags.some(Boolean)
        ? "some"
        : "none";
    return { ...t, days, requested: tri as Trip["requested"] };
  });
}

/** Drop day ids from both the flat rows and each trip; trips emptied of every
 *  day disappear. */
function removeIds(data: UsageResponse, ids: number[]): UsageResponse {
  const idSet = new Set(ids);
  const trips = data.trips
    .map((t) => {
      if (!t.ids.some((id) => idSet.has(id))) return t;
      const days = t.days.filter((d) => !idSet.has(d.id));
      if (days.length === 0) return null;
      const flags = days.map((d) => d.requested);
      const tri = flags.every(Boolean)
        ? "all"
        : flags.some(Boolean)
          ? "some"
          : "none";
      return {
        ...t,
        days,
        ids: t.ids.filter((id) => !idSet.has(id)),
        day_count: days.length,
        total_hours:
          Math.round(days.reduce((s, d) => s + d.hours, 0) * 100) / 100,
        end: days[days.length - 1].date,
        start: days[0].date,
        requested: tri as Trip["requested"],
      };
    })
    .filter((t): t is Trip => t !== null);
  return {
    ...data,
    rows: data.rows.filter((r) => !idSet.has(r.id)),
    trips,
  };
}
