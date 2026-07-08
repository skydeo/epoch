/* Dashboard chart — mirrors the source spreadsheet's "PTO Accrual and Usage".
 *
 * The server (/api/chart) does every calculation; this file only draws:
 *   - PTO Balance   line   (blue)   — end-of-period running balance
 *   - PTO Used      bars   (red)    — non-PH hours taken that period
 *   - PH Used       bars   (pink)   — personal-holiday hours taken that period
 *   - Max Accrued   dashed line (green) — peak balance ever reached
 *   - optional Cap  dashed line (grey) — the 360 h hard cap, OFF by default
 *   - a translucent vertical band marking the current pay period ("today")
 *
 * One shared y-axis (hours) for every series — never a dual axis. Colors are the
 * validated data-viz palette, stepped per light/dark surface. Range presets
 * (YTD / 1yr / All / custom) just refetch /api/chart with start/end params.
 */

(function () {
  "use strict";

  var canvas = document.getElementById("pto-chart");
  if (!canvas || typeof Chart === "undefined") return;

  function isDark() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark") return true;
    if (attr === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function palette() {
    // Validated categorical slots (blue / red / magenta), stepped per surface,
    // plus status-green for the max line and muted ink for chrome.
    return isDark()
      ? {
          balance: "#3987e5",
          pto: "#e66767",
          ph: "#d55181",
          max: "#0ca30c",
          cap: "#898781",
          band: "rgba(96,165,250,0.22)",
          grid: "#2c2c2a",
          axis: "#898781",
          ink: "#c3c2b7",
        }
      : {
          balance: "#2a78d6",
          pto: "#e34948",
          ph: "#e87ba4",
          max: "#0ca30c",
          cap: "#898781",
          band: "rgba(42,120,214,0.16)",
          grid: "#e1e0d9",
          axis: "#898781",
          ink: "#52514e",
        };
  }

  // Inline plugin: shade the current pay period as a vertical band.
  var todayBandPlugin = {
    id: "todayBand",
    beforeDatasetsDraw: function (chart, _args, opts) {
      var idx = opts.index;
      if (idx == null || idx < 0) return;
      var x = chart.scales.x,
        ya = chart.scales.y,
        ctx = chart.ctx;
      var half = (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2 || 6;
      var cx = x.getPixelForValue(idx);
      ctx.save();
      ctx.fillStyle = opts.color;
      ctx.fillRect(cx - half, ya.top, half * 2, ya.bottom - ya.top);
      ctx.restore();
    },
  };
  Chart.register(todayBandPlugin);

  var chart = null;
  var showCap = false;

  function build(data) {
    var c = palette();
    var n = data.labels.length;
    var maxLine = new Array(n).fill(data.max_accrued);
    var capLine = new Array(n).fill(data.cap);

    var datasets = [
      {
        type: "line",
        label: "PTO Balance",
        data: data.balance,
        borderColor: c.balance,
        backgroundColor: c.balance,
        borderWidth: 2,
        pointRadius: n > 60 ? 0 : 3,
        pointHoverRadius: 5,
        tension: 0.15,
        order: 0,
      },
      {
        type: "bar",
        label: "PTO Used",
        data: data.pto_used,
        backgroundColor: c.pto,
        borderRadius: 4,
        borderSkipped: false,
        order: 2,
      },
      {
        type: "bar",
        label: "PH Used",
        data: data.ph_used,
        backgroundColor: c.ph,
        borderRadius: 4,
        borderSkipped: false,
        order: 3,
      },
      {
        type: "line",
        label: "Max Accrued",
        data: maxLine,
        borderColor: c.max,
        borderWidth: 2,
        borderDash: [8, 6],
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        order: 1,
      },
    ];

    if (showCap) {
      datasets.push({
        type: "line",
        label: "Cap (" + data.cap + " h)",
        data: capLine,
        borderColor: c.cap,
        borderWidth: 1.5,
        borderDash: [3, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        order: 1,
      });
    }

    var cfg = {
      data: { labels: data.labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: {
            stacked: false,
            grid: { color: c.grid, drawTicks: false },
            ticks: { color: c.axis, maxRotation: 90, autoSkip: true, maxTicksLimit: 26 },
            title: { display: true, text: "Pay period start", color: c.ink },
          },
          y: {
            beginAtZero: true,
            grid: { color: c.grid },
            ticks: { color: c.axis },
            title: { display: true, text: "Hours", color: c.ink },
          },
        },
        plugins: {
          legend: { labels: { color: c.ink, usePointStyle: true } },
          tooltip: { mode: "index", intersect: false },
          todayBand: { index: data.today_index, color: c.band },
        },
      },
    };

    if (chart) chart.destroy();
    chart = new Chart(canvas, cfg);
  }

  var currentStart = null,
    currentEnd = null;

  function load(start, end) {
    currentStart = start;
    currentEnd = end;
    var qs = [];
    if (start) qs.push("start=" + start);
    if (end) qs.push("end=" + end);
    var url = "/api/chart" + (qs.length ? "?" + qs.join("&") : "");
    fetch(url)
      .then(function (r) {
        return r.json();
      })
      .then(build)
      .catch(function (e) {
        console.error("chart load failed", e);
      });
  }

  // --- Range presets --------------------------------------------------- //
  function ytdStart() {
    return new Date().getFullYear() + "-01-01";
  }
  function yearAgo() {
    var d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }

  var controls = document.getElementById("chart-controls");
  if (controls) {
    controls.addEventListener("click", function (ev) {
      var btn = ev.target.closest("button[data-range]");
      if (!btn) return;
      var range = btn.dataset.range;
      controls.querySelectorAll("button[data-range]").forEach(function (b) {
        b.classList.remove("active");
      });
      if (range === "ytd") {
        btn.classList.add("active");
        load(ytdStart(), null);
      } else if (range === "1yr") {
        btn.classList.add("active");
        load(yearAgo(), null);
      } else if (range === "all") {
        btn.classList.add("active");
        load(null, null);
      } else if (range === "custom") {
        btn.classList.add("active");
        var s = document.getElementById("range-start").value || null;
        var e = document.getElementById("range-end").value || null;
        load(s, e);
      }
    });
  }

  // Redraw on theme flips so colors track the surface.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", function () {
      load(currentStart, currentEnd);
    });

  load(null, null);
})();
