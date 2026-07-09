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
