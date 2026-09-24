import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";
import { DataTable, type Column, type RowState } from "../components/DataTable";
import { Badge, Button, Field, inputCls } from "../components/ui";
import { ErrorState, Spinner } from "../components/states";
import { useToast } from "../components/Toast";
import { ApiError, api, queryKeys } from "../lib/api";
import { todayIso } from "../lib/date";
import { fmtG } from "../lib/format";
import type {
  Holiday,
  SettingField,
  SettingsResponse,
  SettingsUpdate,
  Tier,
} from "../types";


const editInputCls =
  "rounded-field border border-line bg-bg-elev px-2 py-1.5 text-[13px] text-ink " +
  "outline-none w-full min-w-0 focus-visible:ring-2 focus-visible:ring-primary";

// Extract the { errors: [...] } list a 400 PUT returns (kept on ApiError.body).
function settingsErrors(err: unknown): string[] {
  if (err instanceof ApiError) {
    const body = err.body as { errors?: unknown } | null;
    if (Array.isArray(body?.errors)) return body!.errors.map(String);
    return [err.message];
  }
  return ["Could not save settings."];
}

// The active tier: the latest start date on or before today (matches the engine
// fold — "the tier whose start date is the latest one ≤ the period's end").
function activeTierId(tiers: Tier[]): number | null {
  const today = todayIso();
  let best: Tier | null = null;
  for (const t of tiers) {
    if (t.starts_on <= today && (!best || t.starts_on > best.starts_on)) best = t;
  }
  return best?.id ?? null;
}

interface TierDraft {
  starts_on: string;
  annual_days: string;
  annual_hours: string;
  label: string;
}

export function Settings() {
  const qc = useQueryClient();
  const toast = useToast();

  const query = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => api.settings(),
  });
  const data = query.data;

  // Constants change every downstream balance — invalidate the lot (HANDOFF §7).
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["chart"] });
    qc.invalidateQueries({ queryKey: ["accruals"] });
    qc.invalidateQueries({ queryKey: ["usage"] });
    qc.invalidateQueries({ queryKey: ["projection"] });
    qc.invalidateQueries({ queryKey: ["stats"] });
  };

  const setSettingsCache = (patch: Partial<SettingsResponse>) =>
    qc.setQueryData<SettingsResponse>(queryKeys.settings(), (old) =>
      old ? { ...old, ...patch } : old,
    );

  // ===== Constants form =====
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [banner, setBanner] = useState<string[]>([]);

  // Seed the editable copy once constants arrive (and after a save resyncs).
  useEffect(() => {
    if (data?.constants) setForm({ ...data.constants });
  }, [data?.constants]);

  const save = useMutation({
    mutationFn: () => {
      const fields = data?.fields ?? [];
      const payload: SettingsUpdate = {};
      for (const f of fields) {
        const v = form?.[f.key] ?? "";
        payload[f.key] = f.kind === "bool" ? v === "true" : v;
      }
      return api.saveSettings(payload);
    },
    onSuccess: () => {
      setBanner([]);
      toast.success("Settings saved.");
      qc.invalidateQueries({ queryKey: queryKeys.settings() });
      invalidateAll();
    },
    onError: (err) => {
      const errs = settingsErrors(err);
      setBanner(errs);
      toast.error("Couldn't save — check the highlighted fields.");
    },
  });

  // ===== Holidays =====
  const [holiday, setHoliday] = useState({ date: todayIso(), name: "" });

  const addHoliday = useMutation({
    mutationFn: () => api.addHoliday(holiday),
    onSuccess: (res) => {
      setSettingsCache({ holidays: res.holidays });
      setHoliday({ date: todayIso(), name: "" });
      toast.success("Holiday added.");
      invalidateAll();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not add holiday."),
  });

  const delHoliday = useMutation({
    mutationFn: (id: number) => api.deleteHoliday(id),
    onSuccess: (res) => {
      setSettingsCache({ holidays: res.holidays });
      toast.success("Holiday removed.");
      invalidateAll();
    },
    onError: (err) =>
      toast.error(
        err instanceof ApiError ? err.message : "Could not delete holiday.",
      ),
  });

  // ===== Tiers =====
  const [tierForm, setTierForm] = useState<TierDraft>({
    starts_on: todayIso(),
    annual_days: "",
    annual_hours: "",
    label: "",
  });
  const [editingTier, setEditingTier] = useState<number | null>(null);
  const [tierDraft, setTierDraft] = useState<TierDraft | null>(null);

  const tierBody = (d: TierDraft) => ({
    starts_on: d.starts_on,
    annual_days: Number(d.annual_days) || 0,
    annual_hours: Number(d.annual_hours) || 0,
    label: d.label,
  });

  const addTier = useMutation({
    mutationFn: () => api.addTier(tierBody(tierForm)),
    onSuccess: (res) => {
      setSettingsCache({ tiers: res.tiers });
      setTierForm({ starts_on: todayIso(), annual_days: "", annual_hours: "", label: "" });
      toast.success("Tier added.");
      invalidateAll();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not add tier."),
  });

  const updateTier = useMutation({
    mutationFn: (v: { id: number; draft: TierDraft }) =>
      api.updateTier(v.id, tierBody(v.draft)),
    onSuccess: (res) => {
      setSettingsCache({ tiers: res.tiers });
      setEditingTier(null);
      setTierDraft(null);
      toast.success("Tier updated.");
      invalidateAll();
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : "Could not update tier."),
  });

  const deleteTier = useMutation({
    mutationFn: (id: number) => api.deleteTier(id),
    onSuccess: (res) => {
      setSettingsCache({ tiers: res.tiers });
      toast.success("Tier removed.");
      invalidateAll();
    },
    onError: (err) =>
      // Surfaces the last-tier 400 ("at least one tier must remain").
      toast.error(err instanceof ApiError ? err.message : "Could not delete tier."),
  });

  const activeId = useMemo(
    () => (data ? activeTierId(data.tiers) : null),
    [data],
  );

  // --- Holiday table columns ---
  const holidayColumns: Column<Holiday>[] = [
    {
      key: "date",
      header: "Date",
      render: (h) => <span className="font-display font-semibold">{h.date}</span>,
    },
    {
      key: "name",
      header: "Name",
      render: (h) => <span className="text-ink-2">{h.name || "—"}</span>,
    },
    {
      key: "actions",
      header: "·",
      align: "right",
      render: (h) => (
        <Button
          variant="ghost"
          onClick={() => {
            if (window.confirm(`Delete holiday ${h.date}?`)) delHoliday.mutate(h.id);
          }}
        >
          Delete
        </Button>
      ),
    },
  ];

  // --- Tier table columns (inline edit) ---
  const tierColumns: Column<Tier>[] = [
    {
      key: "starts_on",
      header: "Starts on",
      render: (t) =>
        editingTier === t.id && tierDraft ? (
          <input
            type="date"
            className={editInputCls}
            value={tierDraft.starts_on}
            onChange={(e) =>
              setTierDraft((d) => d && { ...d, starts_on: e.target.value })
            }
          />
        ) : (
          <span className="font-display font-semibold">{t.starts_on}</span>
        ),
    },
    {
      key: "days",
      header: "Days",
      align: "right",
      render: (t) =>
        editingTier === t.id && tierDraft ? (
          <input
            type="number"
            step="0.5"
            className={editInputCls}
            value={tierDraft.annual_days}
            onChange={(e) =>
              setTierDraft((d) => d && { ...d, annual_days: e.target.value })
            }
          />
        ) : (
          <span className="font-display tabular-nums">{fmtG(t.annual_days)}</span>
        ),
    },
    {
      key: "hours",
      header: "Hours",
      align: "right",
      render: (t) =>
        editingTier === t.id && tierDraft ? (
          <input
            type="number"
            step="0.5"
            className={editInputCls}
            value={tierDraft.annual_hours}
            onChange={(e) =>
              setTierDraft((d) => d && { ...d, annual_hours: e.target.value })
            }
          />
        ) : (
          <span className="font-display tabular-nums">{fmtG(t.annual_hours)}</span>
        ),
    },
    {
      key: "label",
      header: "Label",
      render: (t) =>
        editingTier === t.id && tierDraft ? (
          <input
            type="text"
            className={editInputCls}
            placeholder="optional"
            value={tierDraft.label}
            onChange={(e) =>
              setTierDraft((d) => d && { ...d, label: e.target.value })
            }
          />
        ) : (
          <span className="flex items-center gap-2 text-ink-2">
            {t.label || "—"}
            {t.id === activeId && (
              <Badge color="var(--primary)" bg="var(--primary-soft)">
                Active
              </Badge>
            )}
          </span>
        ),
    },
    {
      key: "actions",
      header: "·",
      align: "right",
      render: (t) => (
        <span className="flex justify-end gap-2">
          {editingTier === t.id ? (
            <>
              <Button
                variant="primary"
                onClick={() =>
                  tierDraft && updateTier.mutate({ id: t.id, draft: tierDraft })
                }
              >
                Save
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingTier(null);
                  setTierDraft(null);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setEditingTier(t.id);
                  setTierDraft({
                    starts_on: t.starts_on,
                    annual_days: fmtG(t.annual_days),
                    annual_hours: fmtG(t.annual_hours),
                    label: t.label ?? "",
                  });
                }}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  if (window.confirm(`Delete tier starting ${t.starts_on}?`))
                    deleteTier.mutate(t.id);
                }}
              >
                Delete
              </Button>
            </>
          )}
        </span>
      ),
    },
  ];

  const tierRowState = (t: Tier): RowState =>
    t.id === activeId ? "current" : "default";

  if (query.isPending)
    return (
      <section className="animate-epfade">
        <PageHeader title="Settings" blurb="Engine constants, company holidays, and accrual tiers." />
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <Spinner label="Loading settings…" />
        </div>
      </section>
    );

  if (query.isError || !data)
    return (
      <section className="animate-epfade">
        <PageHeader title="Settings" blurb="Engine constants, company holidays, and accrual tiers." />
        <div className="rounded-card border border-line bg-surface shadow-[var(--shadow-sm)]">
          <ErrorState
            message="Could not load settings."
            onRetry={() => query.refetch()}
          />
        </div>
      </section>
    );

  return (
    <section className="animate-epfade">
      <PageHeader
        title="Settings"
        blurb="Engine constants, company holidays, and accrual tiers — the single source of truth for the accrual fold."
      />

      {/* ===== Engine constants ===== */}
      <h2 className="mb-3.5 font-display text-lg font-semibold">Engine constants</h2>

      {banner.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-field border border-danger bg-danger-soft px-3.5 py-3 text-[13px] font-medium text-danger"
        >
          <div className="mb-1 font-semibold">Please fix:</div>
          <ul className="list-disc pl-5">
            {banner.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3.5">
        {data.fields.map((f: SettingField) => (
          <label
            key={f.key}
            className="flex min-w-0 flex-col gap-1.5 rounded-tile border border-line bg-surface px-4 py-3.5 shadow-[var(--shadow-sm)]"
          >
            <span className="text-[12.5px] font-semibold text-ink">{f.label}</span>
            {f.kind === "bool" ? (
              <span className="flex min-h-9 items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={(form?.[f.key] ?? "false") === "true"}
                  onChange={(e) =>
                    setForm((s) => ({
                      ...(s ?? {}),
                      [f.key]: e.target.checked ? "true" : "false",
                    }))
                  }
                />
                Enabled
              </span>
            ) : (
              <input
                type={f.kind === "date" ? "date" : f.kind === "int" ? "number" : "text"}
                inputMode={f.kind === "float" ? "decimal" : undefined}
                step={f.kind === "int" ? "1" : f.kind === "float" ? "any" : undefined}
                className={`${inputCls} w-full max-w-full`}
                style={{ minWidth: 0 }}
                value={form?.[f.key] ?? ""}
                onChange={(e) =>
                  setForm((s) => ({ ...(s ?? {}), [f.key]: e.target.value }))
                }
              />
            )}
            <span className="text-[11.5px] text-ink-3">{f.help}</span>
          </label>
        ))}
      </div>
      <Button onClick={() => save.mutate()} disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save all"}
      </Button>

      {/* ===== Company holidays ===== */}
      <h2 className="mb-1 mt-8 font-display text-lg font-semibold">
        Company holidays
      </h2>
      <p className="mb-3.5 text-[12.5px] text-ink-3">
        Skipped when a usage range is expanded into per-day rows.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          addHoliday.mutate();
        }}
        className="mb-3.5 flex flex-wrap items-end gap-3 rounded-tile border border-line bg-surface px-[18px] py-4 shadow-[var(--shadow-sm)]"
      >
        <Field label="Date">
          <input
            type="date"
            required
            className={inputCls}
            value={holiday.date}
            onChange={(e) => setHoliday((h) => ({ ...h, date: e.target.value }))}
          />
        </Field>
        <Field label="Name" className="flex-1 basis-40">
          <input
            type="text"
            placeholder="e.g. Independence Day"
            className={`${inputCls} w-full`}
            value={holiday.name}
            onChange={(e) => setHoliday((h) => ({ ...h, name: e.target.value }))}
          />
        </Field>
        <Button type="submit" disabled={addHoliday.isPending}>
          {addHoliday.isPending ? "Adding…" : "Add holiday"}
        </Button>
      </form>

      {data.holidays.length === 0 ? (
        <div className="mb-3.5 rounded-card border border-line bg-surface px-4 py-6 text-center text-[13px] text-ink-3 shadow-[var(--shadow-sm)]">
          No company holidays configured.
        </div>
      ) : (
        <div className="mb-3.5">
          <DataTable
            ariaLabel="Company holidays"
            columns={holidayColumns}
            rows={data.holidays}
            rowKey={(h) => h.id}
            gridTemplate="150px minmax(140px,1fr) 96px"
            minWidth={420}
          />
        </div>
      )}

      {/* ===== Accrual tiers ===== */}
      <h2 className="mb-1 mt-6 font-display text-lg font-semibold">Accrual tiers</h2>
      <p className="mb-3.5 max-w-[70ch] text-[12.5px] text-ink-3">
        The rate for a period is the tier whose start date is the latest one on
        or before the period's end. At least one tier must remain.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          addTier.mutate();
        }}
        className="mb-3.5 flex flex-wrap items-end gap-3 rounded-tile border border-line bg-surface px-[18px] py-4 shadow-[var(--shadow-sm)]"
      >
        <Field label="Starts on">
          <input
            type="date"
            required
            className={inputCls}
            value={tierForm.starts_on}
            onChange={(e) =>
              setTierForm((t) => ({ ...t, starts_on: e.target.value }))
            }
          />
        </Field>
        <Field label="Annual days">
          <input
            type="number"
            step="0.5"
            className={inputCls}
            value={tierForm.annual_days}
            onChange={(e) =>
              setTierForm((t) => ({ ...t, annual_days: e.target.value }))
            }
          />
        </Field>
        <Field label="Annual hours">
          <input
            type="number"
            step="0.5"
            className={inputCls}
            value={tierForm.annual_hours}
            onChange={(e) =>
              setTierForm((t) => ({ ...t, annual_hours: e.target.value }))
            }
          />
        </Field>
        <Field label="Label" className="flex-1 basis-40">
          <input
            type="text"
            placeholder="optional"
            className={`${inputCls} w-full`}
            value={tierForm.label}
            onChange={(e) => setTierForm((t) => ({ ...t, label: e.target.value }))}
          />
        </Field>
        <Button type="submit" disabled={addTier.isPending}>
          {addTier.isPending ? "Adding…" : "Add tier"}
        </Button>
      </form>

      <DataTable
        ariaLabel="Accrual tiers"
        columns={tierColumns}
        rows={data.tiers}
        rowKey={(t) => t.id}
        rowState={tierRowState}
        gridTemplate="150px 84px 92px minmax(140px,1.8fr) 150px"
        minWidth={640}
      />
    </section>
  );
}
