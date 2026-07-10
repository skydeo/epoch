import { Link } from "react-router-dom";

import { PageHeader } from "./PageHeader";

// Generic fallback surface. All six sections are now real; this only backs the
// catch-all (404) route.
export function Placeholder({ title, blurb }: { title: string; blurb: string }) {
  return (
    <section className="animate-epfade">
      <PageHeader title={title} blurb={blurb} />
      <div className="rounded-card border border-line bg-surface p-8 text-center shadow-[var(--shadow-sm)]">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-tile bg-primary-soft">
          <span className="h-2.5 w-2.5 rounded-full bg-primary" />
        </div>
        <div className="font-display text-base font-semibold">
          Nothing here
        </div>
        <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-3">
          That page doesn&rsquo;t exist.{" "}
          <Link to="/" className="font-semibold text-primary">
            Back to the dashboard
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
