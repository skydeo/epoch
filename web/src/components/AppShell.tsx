import { NavLink, Outlet } from "react-router-dom";

import { BrandMark } from "./BrandMark";
import { ThemeToggle } from "./ThemeToggle";

interface NavItem {
  to: string;
  label: string;
  dot: string; // CSS var reference for the leading dot
}

// The six sections, in order, with their accent dots (matches the prototype).
const NAV: NavItem[] = [
  { to: "/", label: "Dashboard", dot: "var(--primary)" },
  { to: "/accruals", label: "Accruals", dot: "var(--teal)" },
  { to: "/usage", label: "Usage", dot: "var(--mint)" },
  { to: "/projection", label: "Projection", dot: "var(--warn)" },
  { to: "/settings", label: "Settings", dot: "var(--text-3)" },
  { to: "/import", label: "Import", dot: "var(--danger)" },
];

function SidebarLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        [
          "flex min-h-11 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm no-underline",
          isActive
            ? "bg-primary-soft font-semibold text-ink"
            : "font-medium text-ink-2 hover:text-ink",
        ].join(" ")
      }
    >
      <span
        className="h-2.5 w-2.5 flex-none rounded-[3px]"
        style={{ background: item.dot }}
      />
      <span>{item.label}</span>
    </NavLink>
  );
}

function PillLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        [
          "inline-flex min-h-11 items-center whitespace-nowrap rounded-pill border px-4 py-2 text-[13.5px] font-semibold no-underline",
          isActive
            ? "border-primary bg-primary text-white"
            : "border-line bg-surface-2 text-ink-2",
        ].join(" ")
      }
    >
      {item.label}
    </NavLink>
  );
}

export function AppShell() {
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
          {NAV.map((item) => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
        <div className="mt-auto pt-[18px]">
          <ThemeToggle variant="full" />
        </div>
      </aside>

      {/* ===== Main column ===== */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar (< 900px) */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg-elev px-4 py-3 min-[900px]:hidden">
          <div className="flex items-center gap-2.5">
            <BrandMark size={28} />
            <span className="font-display text-[17px] font-bold">epoch</span>
          </div>
          <ThemeToggle variant="compact" />
        </header>

        {/* Mobile horizontal pill nav (< 900px) */}
        <nav
          aria-label="Primary"
          className="sticky top-[57px] z-[19] flex gap-2 overflow-x-auto border-b border-line bg-bg-elev px-4 py-3 min-[900px]:hidden"
        >
          {NAV.map((item) => (
            <PillLink key={item.to} item={item} />
          ))}
        </nav>

        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-[18px] min-[900px]:px-[44px] min-[900px]:py-[34px]">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
