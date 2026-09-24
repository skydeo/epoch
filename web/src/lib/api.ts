// Thin JSON fetch client + centralized TanStack Query keys.
//
// CONVENTION FOR LATER PHASES:
//  * Every request goes through `apiFetch` (relative `/api/…` URLs; Vite proxies
//    to uvicorn in dev, StaticFiles-hosted same-origin in prod).
//  * Query keys live in `queryKeys` so mutations can invalidate precisely. A
//    usage mutation must invalidate `dashboard`, `chart`, and `accruals` (a
//    balance shift ripples through all three) — HANDOFF §7.

import type {
  AccrualsResponse,
  ChartData,
  DashboardStats,
  Holiday,
  ImportPreview,
  ImportResult,
  ProjectionParams,
  ProjectionResponse,
  SettingsResponse,
  SettingsUpdate,
  StatsResponse,
  Tier,
  UsageBulkPatch,
  UsageCreate,
  UsageEntry,
  UsagePatch,
  UsageResponse,
} from "../types";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : undefined,
    ...init,
  });

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const detail =
      (body as { detail?: unknown } | null)?.detail ?? res.statusText;
    throw new ApiError(
      res.status,
      typeof detail === "string" ? detail : `Request failed (${res.status})`,
      body,
    );
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(
  params: Record<string, string | number | (string | number)[] | undefined>,
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    // Arrays repeat the key (?year=2025&year=2026), as FastAPI list params expect.
    if (Array.isArray(v)) v.forEach((item) => usp.append(k, String(item)));
    else if (v !== undefined && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export interface ChartParams {
  start?: string;
  end?: string;
}

export interface UsageFilters {
  type?: string;
  /** Any of these calendar years; empty/undefined = all years. */
  years?: number[];
  requested?: boolean;
}

export const api = {
  dashboard: () => apiFetch<DashboardStats>("/api/dashboard"),
  chart: (params: ChartParams = {}) =>
    apiFetch<ChartData>(
      `/api/chart${qs({ start: params.start, end: params.end })}`,
    ),
  accruals: (year?: number) =>
    apiFetch<AccrualsResponse>(`/api/accruals${qs({ year })}`),
  usage: (filters: UsageFilters = {}) =>
    apiFetch<UsageResponse>(
      `/api/usage${qs({
        type: filters.type,
        year: filters.years,
        requested:
          filters.requested === undefined ? undefined : String(filters.requested),
      })}`,
    ),
  createUsage: (body: UsageCreate) =>
    apiFetch<{ created: UsageEntry[] }>("/api/usage", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchUsage: (id: number, body: UsagePatch) =>
    apiFetch<{ row: UsageEntry }>(`/api/usage/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteUsage: (id: number) =>
    apiFetch<void>(`/api/usage/${id}`, { method: "DELETE" }),
  bulkPatchUsage: (body: UsageBulkPatch) =>
    apiFetch<{ rows: UsageEntry[] }>("/api/usage/bulk", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  bulkDeleteUsage: (ids: number[]) =>
    apiFetch<{ deleted: number }>("/api/usage/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  // --- Projection / stats ---
  projection: (params: ProjectionParams = {}) =>
    apiFetch<ProjectionResponse>(
      `/api/projection${qs({
        date: params.date,
        whatif_start: params.whatif_start,
        whatif_end: params.whatif_end,
        whatif_type: params.whatif_start ? params.whatif_type : undefined,
        include_planned:
          params.include_planned === false ? "false" : undefined,
      })}`,
    ),
  stats: () => apiFetch<StatsResponse>("/api/stats"),

  // --- Settings ---
  settings: () => apiFetch<SettingsResponse>("/api/settings"),
  saveSettings: (constants: SettingsUpdate) =>
    apiFetch<{ saved: true }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(constants),
    }),
  addHoliday: (body: { date: string; name: string }) =>
    apiFetch<{ holidays: Holiday[] }>("/api/settings/holidays", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteHoliday: (id: number) =>
    apiFetch<{ holidays: Holiday[] }>(`/api/settings/holidays/${id}`, {
      method: "DELETE",
    }),
  addTier: (body: {
    starts_on: string;
    annual_days: number;
    annual_hours: number;
    label: string;
  }) =>
    apiFetch<{ tiers: Tier[] }>("/api/settings/tiers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateTier: (
    id: number,
    body: {
      starts_on: string;
      annual_days: number;
      annual_hours: number;
      label: string;
    },
  ) =>
    apiFetch<{ tiers: Tier[] }>(`/api/settings/tiers/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteTier: (id: number) =>
    apiFetch<{ tiers: Tier[] }>(`/api/settings/tiers/${id}`, {
      method: "DELETE",
    }),

  // --- Import / export ---
  importPreview: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<ImportPreview>("/api/import/preview", {
      method: "POST",
      body: fd,
    });
  },
  importConfirm: (body: { csv_text: string; mode: "replace" | "merge" }) =>
    apiFetch<ImportResult>("/api/import/confirm", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportUrl: "/export/csv",
};

// Query-key registry. Use the factory functions so keys stay structurally
// consistent between reads (useQuery) and invalidations (queryClient).
export const queryKeys = {
  dashboard: () => ["dashboard"] as const,
  chart: (params: ChartParams = {}) => ["chart", params] as const,
  accruals: (year?: number) => ["accruals", year ?? null] as const,
  usage: (filters?: Record<string, unknown>) =>
    ["usage", filters ?? null] as const,
  projection: (params: ProjectionParams = {}) => ["projection", params] as const,
  stats: () => ["stats"] as const,
  settings: () => ["settings"] as const,
};
