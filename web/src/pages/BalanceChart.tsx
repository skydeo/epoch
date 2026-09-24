import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
  type ChartDataset,
  type Plugin,
} from "chart.js";

import { SegmentedControl, type Segment } from "../components/SegmentedControl";
import { EmptyState, ErrorState, Spinner } from "../components/states";
import { api, queryKeys, type ChartParams } from "../lib/api";
import { isoLocal } from "../lib/date";
import { fmtChartLabel } from "../lib/format";
import { useTheme, type Theme } from "../lib/theme";
import type { ChartData } from "../types";

// Register exactly the Chart.js pieces this chart uses (bundled, no CDN).
Chart.register(
  LineController,
  BarController,
  LineElement,
  PointElement,
  BarElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
);

type Range = "ytd" | "1yr" | "all";
const RANGES: Segment<Range>[] = [
  { value: "ytd", label: "YTD" },
  { value: "1yr", label: "1 yr" },
  { value: "all", label: "All" },
];

// §5 palette — literal colors (Chart.js can't read CSS vars from the canvas).
function palette(theme: Theme) {
  return theme === "dark"
    ? {
        balance: "#5088ff",
        peak: "#2bd3c5",
        ptoUsed: "#ff8a5c",
        phUsed: "#ffc94d",
        cap: "#647a97",
        band: "rgba(80,136,255,0.22)",
        grid: "#1c3252",
        axis: "#63799a",
        ink: "#93a6c0",
        tooltipBg: "#0c1728",
      }
    : {
        balance: "#1e50e6",
        peak: "#0a9d92",
        ptoUsed: "#e26a3c",
        phUsed: "#d99311",
        cap: "#8493a8",
        band: "rgba(30,80,230,0.12)",
        grid: "#e6edf6",
        axis: "#8493a8",
        ink: "#54637a",
        tooltipBg: "#0d1b2e",
      };
}

const isoDay = isoLocal;

// Each preset clips the window with an explicit `end` so it never runs out to
// the API's +18-month projection horizon (all presets end at today's period).
//  · YTD → Jan 1 this year → today
//  · 1 yr → trailing 12 months → today
//  · All → hire date (no start) → today
function rangeParams(range: Range): ChartParams {
  const now = new Date();
  const end = isoDay(now);
  if (range === "all") return { end };
  if (range === "ytd") return { start: `${now.getFullYear()}-01-01`, end };
  const back = new Date(now);
  back.setFullYear(back.getFullYear() - 1);
  return { start: isoDay(back), end };
}

// Inline plugin: a translucent vertical band over the current pay period.
const todayBand: Plugin<"bar"> = {
  id: "todayBand",
  beforeDatasetsDraw(chart, _args, opts) {
    const o = opts as { index?: number; color?: string };
    const idx = o.index;
    if (idx == null || idx < 0) return;
    const x = chart.scales.x;
    const y = chart.scales.y;
    if (!x || !y) return;
    const half =
      Math.abs((x.getPixelForValue(1) - x.getPixelForValue(0)) / 2) || 6;
    const cx = x.getPixelForValue(idx);
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = o.color ?? "rgba(0,0,0,0.08)";
    ctx.fillRect(cx - half, y.top, half * 2, y.bottom - y.top);
    ctx.restore();
  },
};

function ChartCanvas({
  data,
  theme,
  showCap,
}: {
  data: ChartData;
  theme: Theme;
  showCap: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  // Build/destroy keyed on [theme, showCap, data] — a new data object arrives on
  // range change (refetch). Guard against a stale Chart bound to this canvas
  // (HANDOFF §11).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const existing = Chart.getChart(canvas);
    if (existing) existing.destroy();
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    const c = palette(theme);
    const n = data.labels.length;
    const labels = data.labels.map(fmtChartLabel);

    const datasets: ChartDataset[] = [
      {
        type: "line",
        label: "PTO Balance",
        data: data.balance,
        borderColor: c.balance,
        backgroundColor: c.balance,
        borderWidth: 2.5,
        pointRadius: n > 45 ? 0 : 2.5,
        pointHoverRadius: 5,
        tension: 0.18,
        order: 0,
        // Every line gets a unique stack key: the scales are stacked for the
        // usage bars, and lines sharing a stack would sum their values.
        stack: "balance",
      },
      {
        type: "bar",
        label: "PTO Used",
        data: data.pto_used,
        backgroundColor: c.ptoUsed,
        borderRadius: 4,
        borderSkipped: false,
        order: 2,
        // PTO and PH stack in one column when used in the same period, so
        // each period keeps the full category width.
        stack: "used",
        barPercentage: 0.9,
        categoryPercentage: 0.8,
      },
      {
        type: "bar",
        label: "PH Used",
        data: data.ph_used,
        backgroundColor: c.phUsed,
        borderRadius: 4,
        borderSkipped: false,
        order: 3,
        stack: "used",
        barPercentage: 0.9,
        categoryPercentage: 0.8,
      },
      {
        type: "line",
        label: "Max Accrued",
        data: new Array(n).fill(data.max_accrued),
        borderColor: c.peak,
        borderWidth: 2,
        borderDash: [8, 6],
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        order: 1,
        stack: "peak",
      },
    ];

    if (showCap) {
      datasets.push({
        type: "line",
        label: `Cap (${data.cap} h)`,
        data: new Array(n).fill(data.cap),
        borderColor: c.cap,
        borderWidth: 1.5,
        borderDash: [3, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        order: 1,
        stack: "cap",
      });
    }

    chartRef.current = new Chart(canvas, {
      type: "bar",
      plugins: [todayBand],
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 450 },
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            stacked: true,
            grid: { color: c.grid, drawTicks: false },
            ticks: {
              color: c.axis,
              maxRotation: 90,
              autoSkip: true,
              maxTicksLimit: 16,
              font: { family: "Space Grotesk", size: 10 },
            },
          },
          // One shared y-axis (hours), never dual.
          y: {
            stacked: true,
            beginAtZero: true,
            grid: { color: c.grid },
            ticks: {
              color: c.axis,
              font: { family: "Space Grotesk", size: 11 },
            },
            title: {
              display: true,
              text: "Hours",
              color: c.ink,
              font: { family: "Figtree", size: 12 },
            },
          },
        },
        plugins: {
          legend: {
            labels: {
              color: c.ink,
              usePointStyle: true,
              boxWidth: 14,
              boxHeight: 8,
              font: { family: "Figtree", size: 12 },
              // Reference lines (Max Accrued / Cap) are drawn as dashed line
              // swatches, not open circles; bars as filled squares; the balance
              // series keeps its round marker.
              generateLabels: (chart) =>
                chart.data.datasets.map((ds, i) => {
                  const isLine = ds.type === "line";
                  const dash =
                    Array.isArray((ds as { borderDash?: number[] }).borderDash)
                      ? (ds as { borderDash?: number[] }).borderDash ?? []
                      : [];
                  const border = ds.borderColor as string | undefined;
                  const fill = ds.backgroundColor as string | undefined;
                  return {
                    text: String(ds.label ?? ""),
                    // Custom items bypass the default generateLabels, which is
                    // what normally copies labels.color — without this the text
                    // falls back to Chart.js's near-black default in dark mode.
                    fontColor: c.ink,
                    fillStyle: isLine ? "transparent" : fill,
                    strokeStyle: isLine ? border ?? fill : fill,
                    lineWidth: isLine ? (ds.borderWidth as number) ?? 2 : 0,
                    lineDash: dash,
                    pointStyle: isLine ? "line" : "rect",
                    hidden: !chart.isDatasetVisible(i),
                    datasetIndex: i,
                  };
                }),
            },
          },
          tooltip: {
            mode: "index",
            intersect: false,
            backgroundColor: c.tooltipBg,
            titleFont: { family: "Space Grotesk" },
            bodyFont: { family: "Figtree" },
            padding: 10,
            cornerRadius: 8,
          },
          // @ts-expect-error custom plugin options are untyped
          todayBand: { index: data.today_index, color: c.band },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [data, theme, showCap]);

  return <canvas ref={canvasRef} />;
}

export function BalanceChart() {
  const { theme } = useTheme();
  const [range, setRange] = useState<Range>("1yr");
  // A specific calendar year overrides the preset; null = a preset is active.
  const [year, setYear] = useState<number | null>(null);
  const [showCap, setShowCap] = useState(false);

  const params = useMemo<ChartParams>(
    () =>
      year !== null
        ? { start: `${year}-01-01`, end: `${year}-12-31` }
        : rangeParams(range),
    [range, year],
  );
  const query = useQuery({
    queryKey: queryKeys.chart(params),
    queryFn: () => api.chart(params),
  });

  const years = query.data?.years ?? [];
  const empty = query.data && query.data.labels.length === 0;

  const pickPreset = (r: Range) => {
    setYear(null);
    setRange(r);
  };

  return (
    <article className="rounded-card border border-line bg-surface px-[22px] pb-[18px] pt-[22px] shadow-[var(--shadow)]">
      <div className="mb-[18px] flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold">
            Balance over time
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-3">
            End-of-period balance, hours used, and the all-time peak.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] font-semibold text-ink-2">
            <input
              type="checkbox"
              checked={showCap}
              onChange={(e) => setShowCap(e.target.checked)}
              className="accent-primary"
            />
            Cap
          </label>
          <SegmentedControl
            segments={RANGES}
            // When a year is picked no preset is highlighted.
            value={year !== null ? ("" as Range) : range}
            onChange={pickPreset}
            ariaLabel="Chart date range"
          />
          <select
            aria-label="Chart year"
            value={year ?? ""}
            onChange={(e) =>
              setYear(e.target.value === "" ? null : Number(e.target.value))
            }
            className={[
              "rounded-[11px] border bg-surface-2 px-2.5 py-1.5 text-[12.5px] font-semibold outline-none",
              "focus-visible:ring-2 focus-visible:ring-primary",
              year !== null
                ? "border-primary text-primary"
                : "border-line text-ink-2",
            ].join(" ")}
          >
            <option value="">Year…</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="relative h-[min(52vh,420px)] w-full">
        {query.isPending && <Spinner label="Loading chart…" />}
        {query.isError && (
          <ErrorState
            message="Could not load chart data."
            onRetry={() => query.refetch()}
          />
        )}
        {empty && <EmptyState message="No periods in this range." />}
        {query.data && !empty && (
          <ChartCanvas data={query.data} theme={theme} showCap={showCap} />
        )}
      </div>
    </article>
  );
}
