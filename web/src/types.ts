// Shared API response types. These mirror the JSON shapes serialized by
// epoch/routes/api.py and epoch/routes/data.py. Keep them in sync with those
// wrappers as later phases add fields.

export type UsageTypeValue = "pto" | "personal_holiday";

export interface DashboardStats {
  current_balance: number;
  current_balance_negative: boolean;
  ph_remaining: number;
  ph_granted: number;
  max_balance: number;
  pct_of_cap: number;
  cap: number;
  pto_used_ytd: number;
  next_pay_date: string | null; // ISO date
  next_pay_accrual: number;
  year: number;
  warnings: string[];
}

export interface ChartData {
  labels: string[]; // ISO period-start dates
  balance: number[];
  pto_used: number[];
  ph_used: number[];
  max_accrued: number;
  cap: number;
  today_index: number; // -1 when the current period is outside the window
}

// --- Shapes for later phases (Accruals / Usage / Projection / Settings). Defined
//     now so the api client and query keys are stable across the build. ---

export interface UsageEntry {
  id: number;
  date: string;
  hours: number;
  type: UsageTypeValue;
  reason: string | null;
  requested: boolean;
}

export interface AccrualRow {
  index: number;
  start: string;
  end: string;
  pay_date: string;
  accrual: number;
  pto_used: number;
  ph_used: number;
  balance: number;
  lost_to_cap: number;
  lost_to_rollover: number;
  state: "past" | "current" | "future";
  is_current: boolean;
}

export interface AccrualsResponse {
  rows: AccrualRow[];
  years: number[];
  current_index: number;
}

export interface UsageResponse {
  rows: UsageEntry[];
  years: number[];
  hire_date: string; // ISO date
  hours_per_day: number;
}

// POST /api/usage body → per-day expansion happens server-side.
export interface UsageCreate {
  start: string;
  end: string;
  type: UsageTypeValue;
  reason: string;
  requested: boolean;
}

// PATCH /api/usage/{id} — partial; covers inline edit and the requested toggle.
export interface UsagePatch {
  date?: string;
  hours?: number;
  type?: UsageTypeValue;
  reason?: string | null;
  requested?: boolean;
}

// --- Projection (GET /api/projection?date=) ---

export interface ProjectionSnap {
  as_of: string;
  period: number;
  pto_balance: number;
  ph_granted: number;
  ph_used: number;
  ph_remaining: number;
  warnings: string[];
}

export interface ProjectionResponse {
  snap: ProjectionSnap;
  period_start: string;
  period_end: string;
  period_pay: string;
  balance_negative: boolean;
  warnings: string[];
  target: string; // ISO date
  today: string; // ISO date
  is_future: boolean;
}

// --- Per-year stats (GET /api/stats) ---

export interface YearStat {
  year: number;
  accrued: number;
  pto_used: number;
  ph_used: number;
  lost_to_cap: number;
  lost_to_rollover: number;
}

export interface StatsResponse {
  years: YearStat[];
}

// --- Settings (GET/PUT /api/settings + holidays/tiers) ---

export type SettingKind = "date" | "int" | "float" | "bool";

export interface SettingField {
  key: string;
  kind: SettingKind;
  label: string;
  help: string;
}

export interface Holiday {
  id: number;
  date: string;
  name: string;
}

export interface Tier {
  id: number;
  starts_on: string;
  annual_days: number;
  annual_hours: number;
  label: string;
}

export interface SettingsResponse {
  constants: Record<string, string>;
  fields: SettingField[];
  holidays: Holiday[];
  tiers: Tier[];
}

// PUT /api/settings — full constants object; bool values as real booleans.
export type SettingsUpdate = Record<string, string | boolean>;

// --- Import (POST /api/import/preview | /confirm) ---

export interface ImportSampleRow {
  date: string;
  hours: number;
  type: UsageTypeValue;
  reason: string | null;
  requested: boolean;
}

export interface ImportPreview {
  count: number;
  errors: string[];
  sample: ImportSampleRow[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  mode: string;
}
