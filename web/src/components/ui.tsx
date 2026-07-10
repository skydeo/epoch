// Shared form + pill primitives, matching the prototype's inputStyle / button /
// badge treatments. Tokens only — no hex (HANDOFF §3). Reused by the Accruals
// and Usage pages (and the later Projection / Settings / Import phases).

import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Prototype `inputStyle`: 10px radius, --bg-elev field on a --border hairline. */
export const inputCls =
  "rounded-field border border-line bg-bg-elev px-3 py-[9px] text-[13.5px] text-ink outline-none " +
  "min-w-[120px] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-0";

/** A stacked label + control, as the prototype's form <label> columns. */
export function Field({
  label,
  htmlFor,
  children,
  className = "",
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={`flex flex-col gap-1.5 text-xs font-semibold text-ink-2 ${className}`}
    >
      {label}
      {children}
    </label>
  );
}

type Variant = "primary" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  // Prototype primaryBtn / secondaryBtn / ghostBtn.
  primary:
    "rounded-[11px] border-0 bg-primary px-[18px] py-2.5 text-[13.5px] font-semibold text-white " +
    "shadow-[var(--shadow-sm)] whitespace-nowrap hover:bg-primary-strong disabled:opacity-60",
  secondary:
    "rounded-[11px] border border-line-strong bg-surface-2 px-[18px] py-2.5 text-[13.5px] " +
    "font-semibold text-ink whitespace-nowrap disabled:opacity-60",
  ghost:
    "rounded-[9px] border border-line bg-transparent px-3 py-1.5 text-[12.5px] font-semibold " +
    "text-ink-2 hover:text-ink hover:border-line-strong disabled:opacity-60",
};

export function Button({
  variant = "primary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`cursor-pointer focus-visible:ring-2 focus-visible:ring-primary ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

/**
 * Soft-bg + saturated-text pill (prototype badgeStyle). `color`/`bg` are CSS var
 * references, e.g. "var(--primary)" / "var(--primary-soft)".
 */
export function Badge({
  children,
  color,
  bg,
  className = "",
}: {
  children: ReactNode;
  color: string;
  bg: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2.5 py-[3px] text-[11px] font-semibold ${className}`}
      style={{ color, background: bg }}
    >
      {children}
    </span>
  );
}
