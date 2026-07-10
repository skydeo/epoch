import type { ReactNode } from "react";

// Standard page title + blurb, with an optional right-aligned slot (badge,
// controls). Used by every section for consistent altitude.
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
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-[29px] font-bold tracking-[-0.025em]">
          {title}
        </h1>
        <p className="mt-1 max-w-[70ch] text-[14.5px] text-ink-2">{blurb}</p>
      </div>
      {right}
    </div>
  );
}
