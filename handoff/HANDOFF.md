# epoch — frontend modernization handoff

This package hands off a **full redesign + full-interactivity rebuild** of the
epoch PTO tracker to Claude Code (running locally against the `skydeo/epoch`
repo).

There are two artifacts:

| File | What it is |
|---|---|
| `Epoch.dc.html` | The **visual + interaction source of truth** — a working, clickable prototype of all six pages, light/dark, desktop/mobile. Open it in a browser. |
| `design-tokens.css` | Every color / font / radius / shadow token, ready to drop in. |
| `handoff.md` (this file) | The build plan: architecture, API contract, component map, acceptance criteria. |

> The prototype is built in a self-contained HTML component framework. **Do not
> copy its markup verbatim** — it uses a bespoke templating runtime. Treat it as
> the design spec: match its layout, spacing, color, typography, states, and
> interactions exactly, but implement in the target stack below.

---

## 1. Goal

Turn epoch from a server-rendered Jinja + HTMX app into a **modern, fully
interactive single-page app** with:

- A cohesive design system (cobalt + teal light / deep-ocean dark) with a
  persisted theme toggle.
- Client-side routing between the six sections (no full-page reloads).
- Snappy, optimistic interactions: inline edits, add/delete, filters, and the
  projection recompute all update in place.
- Tables tuned for **scannability** (strong current-period highlight, status
  color-coding) that gracefully become **cards on mobile**.
- A dashboard chart restyled to the new palette.

**"Full interactive" concretely means:** the user never sees a white
full-page reload; every mutation (toggle requested, delete a day, add a range,
edit a tier, change the projection date, switch year filter) updates the UI
immediately against a JSON API.

---

## 2. Recommended architecture

Keep the excellent pure-Python core; replace only the presentation layer.

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  React + Vite + TypeScript  │  JSON  │  FastAPI (unchanged core)    │
│  SPA  (new /web folder)     │ <────> │  • engine.py  (pure, keep)   │
│  • React Router             │        │  • domain.py  (keep)         │
│  • TanStack Query (fetch)   │        │  • models.py  (SQLModel keep)│
│  • Tailwind + CSS vars      │        │  • NEW: /api/* JSON routes   │
│  • Chart.js                 │        │  • serves built SPA (static) │
└─────────────────────────────┘        └──────────────────────────────┘
```

**Why this shape**
- The accrual engine (`engine.py`, `domain.py`) and `models.py` are already
  clean, pure, and well-tested — **do not touch them**. All the "framework
  change" happens in the view layer.
- FastAPI already returns JSON for the chart (`/api/chart`, `/api/stats`). We
  just add JSON siblings for the other pages and delete the HTML/HTMX routes.
- One container, one deploy. Vite builds static assets; FastAPI serves them via
  `StaticFiles`. `tailscale serve` / Docker / loopback bind are **unchanged**.

**Stack choices (opinionated, override if you prefer):**
- **React 18 + Vite + TypeScript** — matches the prototype's component model.
- **React Router v6** — client routing for the six sections.
- **TanStack Query (react-query)** — data fetching, caching, optimistic updates.
  This is what makes it feel "full interactive" cheaply.
- **Tailwind CSS** driven by the CSS custom properties in `design-tokens.css`
  (so `[data-theme="dark"]` flips the whole app). Do **not** hard-code hex in
  components — reference the tokens.
- **Chart.js 4** — already vendored; keep it.

> Acceptable alternative if you want to minimize churn: stay server-rendered and
> lean harder into HTMX + Alpine.js + view transitions. It can get most of the
> way, but the user explicitly opted into a framework change for real
> interactivity, so the SPA path above is the recommendation.

---

## 3. The design system (from the prototype)

**Fonts** (Google Fonts):
- `Space Grotesk` (400/500/600/700) — all headings, stat values, table
  numerals, dates. Always `font-variant-numeric: tabular-nums` for numbers.
- `Figtree` (400/500/600/700) — body text, labels, buttons.

**Color tokens:** see `design-tokens.css`. Light is default; `[data-theme="dark"]`
is deep-ocean. Persist the choice to `localStorage['epoch-theme']` and set the
attribute on `<html>` before first paint (inline script in `index.html`) to
avoid a flash.

**Shape language:**
- App shell: fixed 250px left sidebar (desktop) → top bar + horizontal scrolling
  pill nav (< 900px). Brand mark = rounded square with a cobalt→teal gradient
  and a ring glyph.
- Cards: `--r-card` (18px), 1px `--border`, `--shadow`.
- Stat tiles: `--r-tile` (16px), tiny 26px icon chip (colored soft bg + a dot).
- Badges/pills: `--r-pill`, soft-bg + saturated text (e.g. Current =
  `--primary` on `--primary-soft`).
- Buttons: primary = solid `--primary` white text; secondary = `--surface-2`
  with `--border-strong`; ghost = transparent + `--border`.

**Table pattern (important — this is the centerpiece):**
- Header row: `--surface-2` bg, uppercase 11.5px `--text-3` labels.
- Rows are a CSS grid. **Desktop:** columns as a real table; numbers
  right-aligned, tabular. **Mobile (< 900px):** each row collapses to a card
  (label–value pairs stacked), header hidden.
- **Current period / current year:** `--current` bg + 3px left `--current-bar`
  and the balance rendered in `--primary`. **Future rows:** ~0.72 opacity.
  **Past:** normal.
- Status pills: Past = muted, Current = cobalt, Upcoming = teal. PTO-used values
  in coral/`--danger`, PH in amber/`--warn`, zeros shown as a muted `·`.

Match the exact paddings, radii, and font sizes by reading the prototype in the
browser and using dev tools; the tokens above cover the palette.

---

## 4. Page / component inventory

Six routes; build these components (names are suggestions):

- **`AppShell`** — sidebar / mobile nav, brand, theme toggle, `<Outlet/>`.
- **`Dashboard`** (`/`) — `StatCard` grid (6) + `BalanceChart` card with a
  YTD / 1yr / All segmented control.
- **`Accruals`** (`/accruals`) — year `<select>` + legend + `LedgerTable`
  (period rows with state highlighting). Auto-scroll the current period into
  view on load.
- **`Usage`** (`/usage`) — range entry form, filter bar (type/year/requested),
  `UsageTable` with an inline requested toggle, edit, and delete per row.
- **`Projection`** (`/projection`) — date picker (recompute on change), a
  3-tile snapshot, a forfeiture note, and the per-year `StatsTable`.
- **`Settings`** (`/settings`) — engine-constants grid (save all), holidays
  table (add/delete), tiers table (add/edit inline/delete, "Active" badge on the
  current tier, never delete the last).
- **`Import`** (`/import`) — drag/drop CSV upload → preview → confirm
  (replace/merge), export button, CSV-format reference list.

Shared: `StatCard`, `Badge`, `Button`, `SegmentedControl`, `DataTable`
(grid-based, responsive), `Field` (labelled input/select), `ThemeToggle`.

---

## 5. Dashboard chart spec

Keep Chart.js. **Restyle to the new palette** (the user explicitly freed you
from the old red/green data-viz colors). One shared y-axis (hours), never dual.

Series & roles (cool = what you *have*, warm = what you *spend*):
- **PTO Balance** — line, `balance` color, width 2.5, light tension 0.18,
  points hidden when > ~45 periods.
- **Max Accrued** — dashed line (`[8,6]`), `peak` color, no points (all-time
  peak reference).
- **PTO Used** — bars, `ptoUsed` color, `borderRadius: 4`.
- **PH Used** — bars, `phUsed` color, `borderRadius: 4`.
- **Cap** (optional, off by default) — thin grey dashed line at the cap.
- **Current period** — translucent vertical band via a small inline plugin at
  `today_index`.

Palette (hex, per theme):

```
LIGHT  balance #1e50e6   peak #0a9d92   ptoUsed #e26a3c   phUsed #d99311
       band rgba(30,80,230,.12)   grid #e6edf6   axis #8493a8   ink #54637a
DARK   balance #5088ff   peak #2bd3c5   ptoUsed #ff8a5c   phUsed #ffc94d
       band rgba(80,136,255,.22)  grid #1c3252   axis #63799a   ink #93a6c0
```

Rebuild the chart on theme change and on range change. Fonts: axis/ticks in
`Space Grotesk`, legend/titles in `Figtree`. Data comes straight from
`GET /api/chart` (already exists, see below).

---

## 6. API contract

`epoch/routes/data.py` already exposes JSON: **`GET /api/chart`** (`{labels[],
balance[], pto_used[], ph_used[], max_accrued, cap, today_index}`, with optional
`?start=&end=`) and **`GET /api/stats`** (`{years:[{year, accrued, pto_used,
ph_used, lost_to_cap, lost_to_rollover}]}`). Reuse both as-is.

Add the following JSON endpoints (new `epoch/routes/api.py`, `prefix="/api"`).
Each is a thin wrapper over the **existing** engine/domain functions — the same
ones the current HTML routes already call — so there is no new business logic,
only serialization. Then remove the HTML page routes (`pages.py`) and the HTMX
partial routes once the SPA is wired.

**Dashboard**
- `GET /api/dashboard` → the stat-card payload. Reuse `pages._dashboard_stats`
  (already computes `current_balance`, `ph_remaining/granted`, `max_balance`,
  `pct_of_cap`, `cap`, `pto_used_ytd`, `next_pay_date`, `next_pay_accrual`,
  `year`, `warnings`). Just return the dict as JSON instead of a template.

**Accruals**
- `GET /api/accruals?year=` → `{ rows: [{index, start, end, pay_date, accrual,
  pto_used, ph_used, balance, lost_to_cap, lost_to_rollover, state,
  is_current}], years: [int], current_index }`. Body already exists in
  `pages.accruals` — return JSON. `state ∈ past|current|future`.

**Usage**
- `GET /api/usage?type=&year=&requested=` → `{ rows: [UsageEntry], years: [int],
  hire_date, hours_per_day }`. (Filter logic already in `usage.usage_rows`.)
- `POST /api/usage` JSON `{start, end, type, reason, requested}` → `201
  {created: [UsageEntry]}`. Reuse `expand_range` + validation (400 on pre-hire
  or weekend/holiday-only range) from `usage.create_usage`.
- `PATCH /api/usage/{id}` JSON `{date?, hours?, type?, reason?, requested?}` →
  `{row: UsageEntry}`. Covers both inline edit and the requested toggle (send
  `{requested: !current}`), collapsing `POST /usage/{id}` and
  `POST /usage/{id}/requested`.
- `DELETE /api/usage/{id}` → `204`.

**Projection**
- `GET /api/projection?date=` → the snapshot dict from
  `pages._projection_snapshot` (`snap`, `period_start/end/pay`,
  `balance_negative`, `warnings`, `target`, `today`, `is_future`) as JSON; `400
  {error}` for an unparseable or pre-hire date. Per-year table uses the existing
  `GET /api/stats`.

**Settings**
- `GET /api/settings` → `{ constants: {key: value}, fields:
  [{key, kind, label, help}], holidays: [{id, date, name}], tiers: [{id,
  starts_on, annual_days, annual_hours, label}] }`. (`SETTINGS_FIELDS` +
  `_load_*` already exist in `settings_ui.py`.)
- `PUT /api/settings` JSON `{key: value, ...}` → `{saved: true}` or `400
  {errors: [str]}`. Reuse `_validate_settings`.
- `POST /api/settings/holidays` `{date, name}` → `{holidays:[...]}`;
  `DELETE /api/settings/holidays/{id}` → `{holidays:[...]}`.
- `POST /api/settings/tiers` `{starts_on, annual_days, annual_hours, label}` →
  `{tiers:[...]}`; `PUT /api/settings/tiers/{id}` → `{tiers:[...]}`;
  `DELETE /api/settings/tiers/{id}` → `{tiers:[...]}` or `400` when it's the
  last tier.

**Import / Export**
- `POST /api/import/preview` (multipart file) → `{count, errors: [str],
  sample?}`. Reuse `parse_usage_csv`.
- `POST /api/import/confirm` JSON `{csv_text, mode}` (`replace|merge`) →
  `{imported, skipped, mode}`.
- `GET /export/csv` → unchanged (already a streaming CSV download).

**Serialization note:** dates as ISO strings, `UsageType` as its `.value`
(`"pto"` / `"personal_holiday"`), floats rounded where the templates round
(balance/accrual 2dp; hours with `%g`).

---

## 7. Interactivity requirements

- **Routing:** React Router, one route per section; active link reflected in the
  nav (matches prototype's active styling). Preserve scroll-to-top on nav.
- **Theme:** toggle persists to `localStorage['epoch-theme']`; applied on
  `<html data-theme>`; pre-paint inline script prevents flash. (Matches the
  prototype exactly.)
- **Optimistic updates (TanStack Query):** requested-toggle, delete, add, tier
  edit — update the cache immediately, roll back on error, refetch the affected
  query (and invalidate `/api/dashboard`, `/api/accruals`, `/api/chart` since a
  usage change shifts balances).
- **Filters** (usage type/year/requested, accruals year) drive query params and
  refetch; no reload.
- **Projection** recomputes on date change (debounce ~150ms).
- **Settings save** shows an inline success toast; validation errors render in a
  banner (reuse `_validate_settings` messages).
- **Import** is preview → confirm; confirm shows imported/skipped counts and
  invalidates all queries.
- **Empty / error / loading states** for every table and the chart.
- **A11y:** real `<button>`/`<a>`, 44px min touch targets on mobile, labelled
  inputs, focus-visible rings, `aria-current` on the active nav item.

---

## 8. Build & deploy changes

- New `web/` (Vite React TS). `web/src` holds the app; `web/dist` is the build
  output.
- `vite.config.ts`: dev `server.proxy` maps `/api` and `/export` to
  `http://127.0.0.1:8000` so `npm run dev` talks to a locally-running FastAPI.
- Serve the SPA from FastAPI: mount `StaticFiles(directory="web/dist",
  html=True)` at `/` (after the API routers), so deep links (`/usage`) fall
  through to `index.html`. Keep `/static` for Chart.js if you don't bundle it.
- **Dockerfile:** add a Node build stage (`npm ci && npm run build` in `web/`),
  copy `web/dist` into the final image. Everything else (loopback bind on 8000,
  `gosu` user remap, `EPOCH_PORT`, `tailscale serve`) is **unchanged**.
- `README.md`: add `cd web && npm install && npm run dev` to the dev section.

---

## 9. Suggested phased plan

1. **API layer** — add `routes/api.py` with the endpoints in §6 (pure
   serialization over existing engine calls). Add a couple of endpoint tests
   mirroring the existing route tests. Keep HTML routes alive for now.
2. **Scaffold** `web/` (Vite + TS + Tailwind + tokens + fonts + Router +
   Query). Build `AppShell`, theme toggle, and the token-driven Tailwind config.
3. **Dashboard** — stat cards + restyled chart against `/api/dashboard` +
   `/api/chart`. Prove the look end-to-end.
4. **Accruals + Usage** — the responsive `DataTable`, current-period
   highlighting, and the full usage CRUD with optimistic updates.
5. **Projection + Settings + Import.**
6. **Wire deploy** (StaticFiles mount + Docker Node stage), delete `pages.py`
   HTML routes + HTMX partial routes + `app.css` / Pico / `dashboard.js` once
   the SPA covers everything. Update README.

---

## 10. Acceptance criteria

- All six sections match `Epoch.dc.html` in layout, color, type, spacing, and
  states, in **both** light and dark, at desktop **and** mobile widths.
- No full-page reloads; every mutation updates in place; theme persists with no
  flash.
- Numbers stay correct: the golden acceptance test still holds — balance
  **134.77** on **2026-07-08**, max balance ever **137.23** (engine untouched;
  `uv run pytest` green, plus the fixture at `tests/fixtures/usage_export.csv`).
- Chart uses the §5 palette and rebuilds on theme/range change.
- `docker compose up -d --build` serves the SPA on the existing loopback port;
  `GET /healthz` unchanged.

---

## 11. Gotchas learned building the prototype

- **Chart.js + a re-rendering view layer:** if the framework ever swaps or
  remounts the `<canvas>`, a chart bound to the old node is orphaned. Guard with
  `Chart.getChart(canvas)` before `new Chart(...)` and destroy any stale
  instance; rebuild when the live chart isn't the one you hold. In React, give
  the canvas a stable key and build/destroy in an effect keyed on
  `[theme, range, showCap]`.
- **Wide ledger tables** need horizontal scroll on narrow desktop OR the
  card-collapse at < 900px — don't let the Balance/Status columns clip.
- **Tabular numerals** everywhere numbers align (`font-variant-numeric:
  tabular-nums` + Space Grotesk) — it's most of what makes the tables feel
  precise.
