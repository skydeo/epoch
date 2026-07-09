// Thin JSON fetch client + centralized TanStack Query keys.
//
// CONVENTION FOR LATER PHASES:
//  * Every request goes through `apiFetch` (relative `/api/…` URLs; Vite proxies
//    to uvicorn in dev, StaticFiles-hosted same-origin in prod).
//  * Query keys live in `queryKeys` so mutations can invalidate precisely. A
//    usage mutation must invalidate `dashboard`, `chart`, and `accruals` (a
//    balance shift ripples through all three) — HANDOFF §7.

import type { ChartData, DashboardStats } from "../types";

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

function qs(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export interface ChartParams {
  start?: string;
  end?: string;
}

export const api = {
  dashboard: () => apiFetch<DashboardStats>("/api/dashboard"),
  chart: (params: ChartParams = {}) =>
    apiFetch<ChartData>(
      `/api/chart${qs({ start: params.start, end: params.end })}`,
    ),
};

// Query-key registry. Use the factory functions so keys stay structurally
// consistent between reads (useQuery) and invalidations (queryClient).
export const queryKeys = {
  dashboard: () => ["dashboard"] as const,
  chart: (params: ChartParams = {}) => ["chart", params] as const,
  accruals: (year?: number) => ["accruals", year ?? null] as const,
  usage: (filters?: Record<string, unknown>) =>
    ["usage", filters ?? null] as const,
  projection: (date?: string) => ["projection", date ?? null] as const,
  stats: () => ["stats"] as const,
  settings: () => ["settings"] as const,
};
