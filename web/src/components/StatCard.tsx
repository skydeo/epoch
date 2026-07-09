// One dashboard stat tile: 26px icon chip (soft bg + a dot), a Figtree label,
// and a big Space Grotesk tabular value with an optional sub-line.

export interface StatCardProps {
  label: string;
  value: string;
  sub: string;
  iconColor: string; // CSS var reference, e.g. "var(--primary)"
  iconBg: string; // CSS var reference, e.g. "var(--primary-soft)"
  iconShape?: "circle" | "square";
  valueColor?: string; // CSS var reference; defaults to --text
}

export function StatCard({
  label,
  value,
  sub,
  iconColor,
  iconBg,
  iconShape = "square",
  valueColor = "var(--text)",
}: StatCardProps) {
  return (
    <article className="rounded-tile border border-line bg-surface p-[18px] shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-center gap-2">
        <span
          className="flex h-[26px] w-[26px] items-center justify-center rounded-lg"
          style={{ background: iconBg }}
          aria-hidden="true"
        >
          <span
            className="h-2 w-2"
            style={{
              background: iconColor,
              borderRadius: iconShape === "circle" ? "50%" : "3px",
            }}
          />
        </span>
        <span className="text-xs font-semibold tracking-[0.02em] text-ink-2">
          {label}
        </span>
      </div>
      <div
        className="font-display text-[32px] font-bold leading-none tracking-[-0.02em] tabular-nums"
        style={{ color: valueColor }}
      >
        {value}
      </div>
      <div className="mt-[7px] text-[12.5px] text-ink-3">{sub}</div>
    </article>
  );
}
