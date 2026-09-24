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
  /** Smaller treatment for the secondary row. */
  compact?: boolean;
}

export function StatCard({
  label,
  value,
  sub,
  iconColor,
  iconBg,
  iconShape = "square",
  valueColor = "var(--text)",
  compact = false,
}: StatCardProps) {
  return (
    <article
      className={[
        "min-w-0 rounded-tile border border-line bg-surface shadow-[var(--shadow-sm)]",
        compact ? "px-2.5 py-2 min-[900px]:px-4 min-[900px]:py-3" : "p-2.5 min-[900px]:p-[18px]",
      ].join(" ")}
    >
      <div className={compact ? "mb-1 flex items-center gap-2" : "mb-1.5 flex items-center gap-2 min-[900px]:mb-3"}>
        <span
          className="hidden h-[26px] w-[26px] flex-none items-center justify-center rounded-lg min-[900px]:flex"
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
        <span className="truncate text-[11.5px] font-semibold tracking-[0.02em] text-ink-2 min-[900px]:text-xs">
          {label}
        </span>
      </div>
      <div
        className={[
          "font-display font-bold leading-none tracking-[-0.02em] tabular-nums",
          compact ? "text-[17px] min-[900px]:text-[22px]" : "text-[24px] min-[900px]:text-[32px]",
        ].join(" ")}
        style={{ color: valueColor }}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] leading-tight text-ink-3 min-[900px]:mt-[7px] min-[900px]:text-[12.5px]">
        {sub}
      </div>
    </article>
  );
}
