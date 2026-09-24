import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const icon = (children: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
    {children}
  </svg>
);

const ICONS = {
  home: icon(
    <>
      <path d="M3 11l9-7 9 7" />
      <path d="M5 10v10h14V10" />
    </>,
  ),
  accruals: icon(
    <>
      <path d="M4 20V14M10 20V9M16 20V11M22 20H2" />
      <path d="M4 9l6-5 6 3 5-4" />
    </>,
  ),
  usage: icon(
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>,
  ),
  planner: icon(
    <>
      <path d="M3 18h18M7 18a5 5 0 0 1 10 0M12 7v2M5.6 10.6l1.4 1.4M18.4 10.6L17 12" />
    </>,
  ),
  settings: icon(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9L7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>,
  ),
  import: icon(
    <>
      <path d="M12 4v11M7 10l5 5 5-5M4 20h16" />
    </>,
  ),
  more: icon(
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>,
  ),
};

// Primary sections — every one is a bottom tab on mobile.
const PRIMARY: NavItem[] = [
  { to: "/", label: "Home", icon: ICONS.home },
  { to: "/accruals", label: "Accruals", icon: ICONS.accruals },
  { to: "/usage", label: "Usage", icon: ICONS.usage },
  { to: "/projection", label: "Planner", icon: ICONS.planner },
];

// Secondary sections — sidebar on desktop, the "More" sheet on mobile.
const SECONDARY: (NavItem & { hint: string })[] = [
  { to: "/settings", label: "Settings", icon: ICONS.settings, hint: "tiers, holidays" },
  { to: "/import", label: "Import & export", icon: ICONS.import, hint: "CSV" },
];

const TITLES: Record<string, string> = {
  "/": "epoch",
  "/accruals": "Accruals",
  "/usage": "Usage",
  "/projection": "Planner",
  "/settings": "Settings",
  "/import": "Import & export",
};

function SidebarLink({ item, label }: { item: NavItem; label?: string }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        [
          "flex min-h-11 items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm no-underline",
          isActive
            ? "bg-primary-soft font-semibold text-primary"
            : "font-medium text-ink-2 hover:text-ink",
        ].join(" ")
      }
    >
      {item.icon}
      <span>{label ?? item.label}</span>
    </NavLink>
  );
}

function TabLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        [
          "flex min-h-[50px] flex-col items-center justify-center gap-[3px] text-[11px] font-semibold no-underline",
          isActive ? "text-primary" : "text-ink-3",
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={[
              "flex h-7 w-[52px] items-center justify-center rounded-pill",
              isActive ? "bg-primary-soft" : "",
            ].join(" ")}
          >
            {item.icon}
          </span>
          <span>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-30 min-[900px]:hidden">
      <button
        type="button"
        aria-label="Close menu"
        onClick={onClose}
        className="absolute inset-0 bg-[rgba(7,15,28,0.45)]"
      />
      <div
        role="dialog"
        aria-label="More"
        className="absolute inset-x-0 bottom-[calc(57px+max(6px,env(safe-area-inset-bottom)))] flex flex-col gap-1.5 rounded-t-[20px] bg-bg-elev px-3.5 pb-3.5 pt-2 shadow-[0_-10px_30px_rgba(13,27,46,.18)]"
      >
        <div className="mb-1.5 h-[5px] w-10 self-center rounded-pill bg-line-strong" />
        {SECONDARY.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onClose}
            className="flex min-h-12 items-center gap-3 rounded-xl px-1.5 text-[15.5px] font-semibold text-ink no-underline"
          >
            <span className="text-ink-2">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            <span className="text-[13px] font-medium text-ink-3">{item.hint}</span>
          </NavLink>
        ))}
        <div className="my-1 h-px bg-line" />
        <div className="flex flex-col gap-2 p-1.5">
          <span className="text-[13px] font-bold text-ink-2">Appearance</span>
          <ThemeToggle size="lg" />
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const title = TITLES[pathname] ?? "epoch";
  const inSecondary = SECONDARY.some((s) => s.to === pathname);

  // Close the sheet on navigation.
  useEffect(() => setMoreOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen bg-bg text-ink">
      {/* ===== Desktop sidebar (>= 900px) ===== */}
      <aside className="sticky top-0 hidden h-screen w-[250px] flex-none flex-col border-r border-line bg-bg-elev px-4 py-[22px] min-[900px]:flex">
        <div className="flex items-center gap-[11px] px-2 pb-[22px] pt-1.5">
          <BrandMark size={34} />
          <div className="flex flex-col leading-none">
            <span className="font-display text-[19px] font-bold tracking-[-0.02em]">
              epoch
            </span>
            <span className="mt-[3px] text-[11px] tracking-[0.04em] text-ink-3">
              PTO TRACKER
            </span>
          </div>
        </div>
        <nav className="flex flex-col gap-[3px]" aria-label="Primary">
          {PRIMARY.map((item) => (
            <SidebarLink
              key={item.to}
              item={item}
              label={item.to === "/" ? "Dashboard" : undefined}
            />
          ))}
          <div className="my-2 h-px bg-line" />
          {SECONDARY.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
        <div className="mt-auto pt-[18px]">
          <ThemeToggle />
        </div>
      </aside>

      {/* ===== Main column ===== */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar (< 900px): brand + the current page's name. */}
        <header className="sticky top-0 z-20 flex h-[calc(52px+env(safe-area-inset-top))] items-center gap-2.5 border-b border-line bg-bg-elev px-3.5 pt-[env(safe-area-inset-top)] min-[900px]:hidden">
          <BrandMark size={28} />
          <h1 className="font-display text-[19px] font-semibold tracking-[-0.01em]">
            {title}
          </h1>
        </header>

        <main className="mx-auto w-full max-w-[1180px] flex-1 px-3 pb-[calc(84px+env(safe-area-inset-bottom))] pt-3 min-[900px]:px-[44px] min-[900px]:py-[34px]">
          <Outlet />
        </main>

        {/* Mobile bottom tab bar. */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-line bg-bg-elev px-1.5 pb-[max(6px,env(safe-area-inset-bottom))] pt-1.5 min-[900px]:hidden"
        >
          {PRIMARY.map((item) => (
            <TabLink key={item.to} item={item} />
          ))}
          <button
            type="button"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            className={[
              "flex min-h-[50px] flex-col items-center justify-center gap-[3px] text-[11px] font-semibold",
              moreOpen || inSecondary ? "text-primary" : "text-ink-3",
            ].join(" ")}
          >
            <span
              className={[
                "flex h-7 w-[52px] items-center justify-center rounded-pill",
                moreOpen || inSecondary ? "bg-primary-soft" : "",
              ].join(" ")}
            >
              {ICONS.more}
            </span>
            <span>More</span>
          </button>
        </nav>
        {moreOpen && <MoreSheet onClose={() => setMoreOpen(false)} />}
      </div>
    </div>
  );
}
