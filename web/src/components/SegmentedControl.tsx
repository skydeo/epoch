// Segmented control (a la the prototype's chart range switch): a pill track with
// the active segment raised on --bg-elev with a soft shadow.

export interface Segment<T extends string> {
  value: T;
  label: string;
}

export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  ariaLabel,
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex gap-1.5 rounded-[11px] bg-surface-2 p-1"
    >
      {segments.map((seg) => {
        const active = seg.value === value;
        return (
          <button
            key={seg.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(seg.value)}
            className={[
              "rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold",
              active
                ? "bg-bg-elev text-primary shadow-[var(--shadow-sm)]"
                : "bg-transparent text-ink-2",
            ].join(" ")}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
}
