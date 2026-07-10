import { useTheme } from "../lib/theme";

// Sidebar variant: full-width button showing the theme name + hint.
// Compact variant: small pill for the mobile top bar.
export function ThemeToggle({ variant = "full" }: { variant?: "full" | "compact" }) {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Deep ocean" : "Airy light";
  const hint = dark ? "☾ Dark" : "☀ Light";

  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
        className="min-h-11 rounded-field border border-line bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-ink-2"
      >
        {hint}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      className="flex w-full items-center justify-between gap-2.5 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[13.5px] font-semibold text-ink-2"
    >
      <span>{label}</span>
      <span className="font-display text-xs text-ink-3">{hint}</span>
    </button>
  );
}
