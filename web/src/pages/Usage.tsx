import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { DataTable, type Column } from "../components/DataTable";
import { Badge, Button, Field, inputCls } from "../components/ui";
import { EmptyState, ErrorState, Spinner } from "../components/states";
import { ApiError, api, queryKeys, type UsageFilters } from "../lib/api";
import { fmtG } from "../lib/format";
import type { UsageEntry, UsageResponse, UsageTypeValue } from "../types";

const editInputCls =
  "rounded-field border border-line bg-bg-elev px-2 py-1.5 text-[13px] text-ink " +
  "outline-none w-full min-w-0 focus-visible:ring-2 focus-visible:ring-primary";

const todayIso = () => new Date().toISOString().slice(0, 10);

// The usage list lives under the "usage" query-key prefix (one cache entry per
// filter combo). Optimistic mutations update every matching entry at once.
const USAGE_ROOT = { queryKey: ["usage"] as const };

interface EditDraft {
  date: string;
  hours: string;
  type: UsageTypeValue;
  reason: string;
}

export function Usage() {
  const qc = useQueryClient();

  // --- Filters drive the query params (HANDOFF §7) ---
  const [type, setType] = useState<"" | UsageTypeValue>("");
  const [yearFilter, setYearFilter] = useState<"" | number>("");
  const [requested, setRequested] = useState<"" | "true" | "false">("");
  // Newest date first by default (current data at the top).
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

  // --- Balance-rippling invalidation: a usage change shifts every downstream
  //     balance (dashboard cards, chart, accrual ledger). HANDOFF §7. ---
  const invalidateBalances = () => {
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["chart"] });
    qc.invalidateQueries({ queryKey: ["accruals"] });
  };

  const patchCache = (fn: (rows: UsageEntry[]) => UsageEntry[]) => {
    qc.setQueriesData<UsageResponse>(USAGE_ROOT, (old) =>
      old ? { ...old, rows: fn(old.rows) } : old,
    );
  };
  const snapshot = () => qc.getQueriesData<UsageResponse>(USAGE_ROOT);
  const restore = (
    prev: ReturnType<typeof snapshot> | undefined,
  ) => prev?.forEach(([key, data]) => qc.setQueryData(key, data));

  // --- Toggle "requested" (optimistic) ---
  const toggle = useMutation({
    mutationFn: (v: { id: number; requested: boolean }) =>
      api.patchUsage(v.id, { requested: v.requested }),
    onMutate: async ({ id, requested }) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      patchCache((rows) =>
        rows.map((r) => (r.id === id ? { ...r, requested } : r)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => restore(ctx?.prev),
    onSettled: () => qc.invalidateQueries(USAGE_ROOT),
  });

  // --- Delete (optimistic) ---
  const del = useMutation({
    mutationFn: (id: number) => api.deleteUsage(id),
    onMutate: async (id) => {
      await qc.cancelQueries(USAGE_ROOT);
      const prev = snapshot();
      patchCache((rows) => rows.filter((r) => r.id !== id));
      return { prev };
    },
    onError: (_e, _id, ctx) => restore(ctx?.prev),
    onSettled: () => {
      qc.invalidateQueries(USAGE_ROOT);
      invalidateBalances();
    },
  });

  // --- Inline edit (optimistic) ---
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
      // updates in place; the settle-invalidate reconciles filters/sort.
      patchCache((rows) =>
        [...rows, ...data.created].sort(
          (a, b) => a.date.localeCompare(b.date) || a.id - b.id,
        ),
      );
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

  const addError =
    add.error instanceof ApiError ? add.error.message : null;

  const columns: Column<UsageEntry>[] = useMemo(
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
          const isPh = r.type === "personal_holiday";
          return (
            <Badge
              color={isPh ? "var(--warn)" : "var(--danger)"}
              bg={isPh ? "var(--warn-soft)" : "var(--danger-soft)"}
              className="text-[11.5px]"
            >
              {isPh ? "Personal Holiday" : "PTO"}
            </Badge>
          );
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
          <button
            type="button"
            onClick={() => toggle.mutate({ id: r.id, requested: !r.requested })}
            className="cursor-pointer rounded-pill border px-3 py-1 text-xs font-semibold"
            style={{
              borderColor: r.requested ? "var(--mint)" : "var(--border)",
              background: r.requested ? "var(--teal-soft)" : "transparent",
              color: r.requested ? "var(--mint)" : "var(--text-3)",
            }}
            aria-pressed={r.requested}
          >
            {r.requested ? "✓ Yes" : "No"}
          </button>
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

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Usage"
        blurb="Log PTO and personal-holiday days. A range expands to one row per working day."
      />

      {/* ===== Add range ===== */}
      <form
        onSubmit={submitAdd}
        className="mb-4 flex flex-wrap items-end gap-3 rounded-tile border border-line bg-surface px-[18px] py-4 shadow-[var(--shadow-sm)]"
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
        <Field label="Reason" className="flex-1 basis-40">
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

      {addError && (
        <div
          role="alert"
          className="mb-4 rounded-field border border-danger bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger"
        >
          {addError}
        </div>
      )}

      {/* ===== Filters ===== */}
      <div className="mb-4 flex flex-wrap gap-3">
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
        ) : (
          <DataTable
            ariaLabel="Usage log"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            gridTemplate="110px 64px 140px minmax(120px,1fr) 96px 150px"
            minWidth={700}
          />
        ))}
    </section>
  );
}
