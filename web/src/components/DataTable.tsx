// Generic, grid-based responsive table — the shared centerpiece (HANDOFF §3).
//
// Desktop (>= 900px): a real table. Header row on --surface-2 with uppercase
// 11.5px --text-3 labels; body rows are CSS grids using the caller's
// `gridTemplate`; numbers right-aligned + tabular.
//
// Mobile (< 900px): pass `renderMobile` to get a dense divider-separated list
// where the caller composes each row (typically two lines: the key facts and
// the numbers). Without it, rows fall back to cards of label–value pairs via
// index.css (`.dt` custom properties) — fine for short settings tables.
//
// Row-state styling: `current` → --current bg + 3px --current-bar left bar;
// `future` → ~0.72 opacity; `past`/`default` → normal. Pass `scrollToKey` to
// auto-scroll a row into view on first load (Accruals' current period).

import { Fragment, useRef, type ReactNode } from "react";

import { useIsMobile } from "../lib/useMediaQuery";

export type RowState = "past" | "current" | "future" | "default";

export interface Column<Row> {
  key: string;
  /** Uppercase desktop header label. */
  header: string;
  /** Mobile label; defaults to `header`. */
  label?: string;
  align?: "left" | "right" | "center";
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  /** Desktop `grid-template-columns` value, e.g. "40px minmax(130px,1.5fr) …". */
  gridTemplate: string;
  /** Min content width so wide tables scroll rather than clip (HANDOFF §11). */
  minWidth?: number;
  rowKey: (row: Row) => string | number;
  rowState?: (row: Row) => RowState;
  /** Scroll the row with this key into view (block:center) on first appearance. */
  scrollToKey?: string | number | null;
  /**
   * Optional expandable-row content: return a node to reveal a full-width panel
   * directly beneath the row (e.g. a trip's per-day rows), or a falsy value to
   * leave the row collapsed. Rendered as a block sibling so it spans all cols.
   */
  renderExpanded?: (row: Row) => ReactNode;
  /** Compact mobile row content (< 900px); replaces the label–value card. */
  renderMobile?: (row: Row) => ReactNode;
  ariaLabel: string;
}

function justify(align: Column<unknown>["align"]): string {
  if (align === "right") return "var(--dt-jnum)";
  if (align === "center") return "var(--dt-jctr)";
  return "var(--dt-jtxt)";
}

export function DataTable<Row>({
  columns,
  rows,
  gridTemplate,
  minWidth,
  rowKey,
  rowState,
  scrollToKey,
  renderExpanded,
  renderMobile,
  ariaLabel,
}: DataTableProps<Row>) {
  const isMobile = useIsMobile();
  // Track the last key we auto-scrolled to so we only do it once per target.
  const scrolledRef = useRef<string | number | null>(null);
  if (scrollToKey == null || scrolledRef.current !== scrollToKey) {
    if (scrollToKey == null) scrolledRef.current = null;
  }

  const setRowRef =
    (key: string | number) => (el: HTMLDivElement | null) => {
      if (
        el &&
        scrollToKey != null &&
        key === scrollToKey &&
        scrolledRef.current !== scrollToKey
      ) {
        scrolledRef.current = scrollToKey;
        el.scrollIntoView({ block: "center" });
      }
    };

  if (isMobile && renderMobile) {
    return (
      <div
        role="list"
        aria-label={ariaLabel}
        className="rounded-[14px] border border-line bg-surface"
      >
        {rows.map((row) => {
          const key = rowKey(row);
          const state = rowState?.(row) ?? "default";
          const expanded = renderExpanded?.(row);
          return (
            <div
              key={key}
              role="listitem"
              ref={setRowRef(key)}
              className={[
                // No overflow-hidden on the list (row menus pop out of it), so
                // the ends round themselves to keep highlights in the corners.
                "border-b border-line first:rounded-t-[13px] last:rounded-b-[13px] last:border-b-0",
                state === "current" ? "bg-[var(--current)]" : "",
                state === "future" ? "opacity-75" : "",
                expanded ? "bg-surface-2" : "",
              ].join(" ")}
            >
              {renderMobile(row)}
              {expanded ? <div className="pb-2">{expanded}</div> : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="dt overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow)]">
      <div className="overflow-x-auto">
        <div
          role="table"
          aria-label={ariaLabel}
          className="dt-body"
          style={
            {
              "--dt-min": minWidth ? `${minWidth}px` : "auto",
              "--dt-desk-cols": gridTemplate,
            } as React.CSSProperties
          }
        >
          {/* Header (hidden < 900px via --dt-thead) */}
          <div
            role="row"
            className="dt-head border-b border-line bg-surface-2 px-3.5 py-[13px] text-[11.5px] font-bold uppercase tracking-[0.04em] text-ink-3"
          >
            {columns.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                style={{ textAlign: c.align ?? "left" }}
              >
                {c.header}
              </div>
            ))}
          </div>

          {rows.map((row) => {
            const key = rowKey(row);
            const state = rowState?.(row) ?? "default";
            const stateStyle: React.CSSProperties =
              state === "current"
                ? {
                    background: "var(--current)",
                    borderLeft: "3px solid var(--current-bar)",
                  }
                : state === "future"
                  ? { opacity: 0.72 }
                  : {};
            const expanded = renderExpanded?.(row);
            return (
              <Fragment key={key}>
                <div
                  role="row"
                  ref={setRowRef(key)}
                  className="dt-row"
                  style={stateStyle}
                >
                  {columns.map((c) => (
                    <div
                      key={c.key}
                      role="cell"
                      className="flex min-w-0 items-center gap-2.5"
                      style={{ justifyContent: justify(c.align) }}
                    >
                      <span
                        className="text-[11.5px] font-semibold text-ink-3"
                        style={{ display: "var(--dt-lbl)" }}
                      >
                        {c.label ?? c.header}
                      </span>
                      <span className="min-w-0">{c.render(row)}</span>
                    </div>
                  ))}
                </div>
                {expanded ? (
                  <div className="border-b border-line bg-surface-2 px-3 py-3">
                    {expanded}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
