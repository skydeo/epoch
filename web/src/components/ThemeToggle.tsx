import type { ReactNode } from "react";

import { useTheme, type ThemePreference } from "../lib/theme";

const OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    value: "system",
    label: "System",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <rect x="5" y="2" width="14" height="20" rx="3" />
        <path d="M11 18h2" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />
      </svg>
    ),
  },
];

// Three-way System / Light / Dark segmented control. Used at the foot of the
// desktop sidebar and inside the mobile "More" sheet.
export function ThemeToggle({ size = "sm" }: { size?: "sm" | "lg" }) {
  const { preference, setPreference, theme } = useTheme();
  const tall = size === "lg";
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid grid-cols-3 rounded-xl border border-line bg-surface-2 p-[3px]"
      >
        {OPTIONS.map((opt) => {
          const active = preference === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPreference(opt.value)}
              className={[
                "flex items-center justify-center gap-1.5 rounded-[9px] text-[13px]",
                tall ? "h-10 text-[14px]" : "h-8",
                active
                  ? "bg-surface font-bold text-ink shadow-[var(--shadow-sm)]"
                  : "font-semibold text-ink-2 hover:text-ink",
              ].join(" ")}
            >
              {tall && opt.icon}
              {opt.label}
            </button>
          );
        })}
      </div>
      {preference === "system" && (
        <span className="px-1 text-[12px] text-ink-3">
          Following your device, which is {theme} right now.
        </span>
      )}
    </div>
  );
}
