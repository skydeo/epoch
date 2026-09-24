// Local-calendar date helpers. `new Date().toISOString()` is UTC, which rolls
// over to "tomorrow" every evening in US time zones — always go through these.

/** ISO `YYYY-MM-DD` for a Date in the *local* time zone. */
export function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today as a local ISO date. */
export function todayIso(): string {
  return isoLocal(new Date());
}

/** Parse `YYYY-MM-DD` as a local-midnight Date (not UTC). */
export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** `iso` shifted by whole months, day clamped to the target month's length. */
export function addMonths(iso: string, months: number): string {
  const d = parseIso(iso);
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), last));
  return isoLocal(target);
}

/** `iso` shifted by whole days. */
export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return isoLocal(d);
}

/** "Mar 1" / "Mar 1, 2027" (year shown when it isn't the current one). */
export function fmtShort(iso: string, opts: { year?: boolean } = {}): string {
  const d = parseIso(iso);
  const showYear = opts.year ?? d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(showYear ? { year: "numeric" } : {}),
  });
}

/** "Mon, Mar 1, 2027". */
export function fmtLong(iso: string): string {
  return parseIso(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Aug 3 – 16" / "Jul 20 – Aug 2" / "Dec 22 – Jan 4". */
export function fmtRange(startIso: string, endIso: string): string {
  const s = parseIso(startIso);
  const e = parseIso(endIso);
  if (startIso === endIso) return fmtShort(startIso, { year: false });
  const sm = s.toLocaleDateString("en-US", { month: "short" });
  const em = e.toLocaleDateString("en-US", { month: "short" });
  return sm === em && s.getFullYear() === e.getFullYear()
    ? `${sm} ${s.getDate()} – ${e.getDate()}`
    : `${sm} ${s.getDate()} – ${em} ${e.getDate()}`;
}
