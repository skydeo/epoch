import { PageHeader } from "./PageHeader";

// Stand-in for the five sections built in later phases. Keeps routing complete
// so nav active-states and deep links all work today.
export function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <section className="animate-epfade">
      <PageHeader title={title} blurb={blurb} />
      <div className="rounded-card border border-line bg-surface p-8 text-center shadow-[var(--shadow-sm)]">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-tile bg-primary-soft">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" />
        </div>
        <div className="font-display text-base font-semibold">
          Coming in a later phase
        </div>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-3">
          This section is part of the frontend rebuild and lands in a subsequent
          phase. The dashboard is live now.
        </p>
      </div>
    </section>
  );
}
