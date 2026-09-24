import type { ReactNode } from "react";

// Standard page title + blurb, with an optional right-aligned slot (badge,
// controls). On mobile the AppShell top bar already names the page, so the
// title and blurb collapse away and only the `right` slot remains.
export function PageHeader({
  title,
  blurb,
  right,
}: {
  title: string;
  blurb: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3 max-[899px]:mb-3 max-[899px]:empty:hidden">
      <div className="max-[899px]:hidden">
        <h1 className="font-display text-[29px] font-bold tracking-[-0.025em]">
          {title}
        </h1>
        <p className="mt-1 max-w-[70ch] text-[14.5px] text-ink-2">{blurb}</p>
      </div>
      {right}
    </div>
  );
}
