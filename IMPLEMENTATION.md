# epoch — self-hosted PTO tracker: implementation plan

## Context

The user tracks PTO in a Google Sheet (biweekly accruals, usage log, balance chart) and wants to replace it with a self-hosted web app on his tailnet, deployed exactly like his existing `fetch` project (`/Users/xander/Documents/fetch`). Single user, Python/FastAPI developer, little frontend experience. The project lives at `/Users/xander/Documents/epoch` (currently just 3 reference screenshots: `constants.png`, `table.png`, `chart.png` — keep them, they're the visual spec).

**Decisions already made with the user:**
- Frontend: server-rendered **Jinja2 + HTMX + Chart.js** (vendored static assets), Pico.css v2 for styling.
- Limits: balance hard-capped at **360 hrs** always (accrual truncated); at **calendar year end** balance above **240 hrs** is forfeited.
- History: **CSV import** of the sheet's usage table; accruals recomputed from rules.
- Tiers: 22 days/yr now, **+5 days at 5 years (2028-01-09), +5 more at 10 years (2033-01-09)** → 176 / 216 / 256 hrs/yr. Personal holidays: 2 days (16 hrs) granted Jan 1, use-or-lose Dec 31.
- No auth (tailnet-only), SQLite, single Docker container on `127.0.0.1` fronted by `tailscale serve`.

## Verified facts the implementation MUST honor

Independently verified with date arithmetic (do not re-derive differently):

1. **Periods are pure 14-day arithmetic anchored at hire date 2023-01-09 (a Monday).** Period `n` (1-based): `start = hire + (n-1)*14d`, `end = start + 13d`, `pay_date = end + 5d`. The sheet's "row 94" period 2026-07-06 → 2026-07-19 (pay 2026-07-24) is **period index 92** (sheet has 2 header rows). `period_index_for(2026-07-08) == 92`.
2. **Accrual per period is the ROUNDED rate: `round(annual_hours / 26, 2)`** → 6.77 / 8.31 / 9.85. Using full precision 176/26 drifts off the sheet. Replaying visible sheet rows with 6.77 and rounding the running balance to 2dp each step reproduces every value exactly: 111.38 → 118.15 → 124.92 → 123.69 → 130.46 → 137.23 → 128.00 → **134.77** (balance on 2026-07-08). Max balance ever = **137.23**.
3. **Tier rule: a period accrues at the tier whose `starts_on` ≤ period END date.** Period 130 (ends 2028-01-02) is the last at 6.77; period 131 (2028-01-03 → 2028-01-16, contains the 5-yr mark) is the first at 8.31.
4. **Rollover applies to the period that straddles Jan 1** (e.g., period 104: 2026-12-21 → 2027-01-03): clamp the *incoming* balance to 240 before that period's accrual/usage.

## Conventions to mirror from `fetch`

Read `/Users/xander/Documents/fetch` before scaffolding. Reuse: Python ≥3.14, uv (`[tool.uv] package = false`), `fetch/db.py` pattern near-verbatim (engine, WAL pragmas, `get_session`, additive `_add_missing_columns` migration, `reset_engine`), pydantic-settings + `.env`, `create_app(settings)` factory, unauthenticated `/healthz`, Dockerfile/entrypoint.sh (PUID/PGID + gosu; drop ffmpeg), compose file bound `127.0.0.1:${EPOCH_PORT:-8193}:8000` with `./data:/data`, pytest `conftest.py` fixture style (tmp_path settings/db/client). **Skip** fetch's auth, worker pool, rate limiting, metrics, ntfy — epoch has none of that. `git init` the repo first (it isn't one), and save this plan into the repo as `IMPLEMENTATION.md` (fetch's convention).

## Project layout

```
epoch/
├── pyproject.toml        # deps: fastapi, uvicorn, sqlmodel, pydantic-settings, jinja2, python-multipart
│                         # dev: pytest, httpx
├── .env.example  .gitignore  Dockerfile  docker-compose.yml  entrypoint.sh  README.md  IMPLEMENTATION.md
├── epoch/
│   ├── main.py           # create_app(settings) + lifespan (init_db + seed_defaults); mounts /static
│   ├── config.py         # infra only: db_path (default /data/epoch.db)
│   ├── db.py             # ported from fetch/db.py
│   ├── models.py         # UsageEntry, CompanyHoliday, AccrualTier, AppSetting
│   ├── seed.py           # idempotent insert-if-missing (user edits survive restarts)
│   ├── engine.py         # PURE accrual engine — stdlib only, no epoch imports
│   ├── domain.py         # DB→engine bridge: load_engine_config, load_usage, expand_range
│   ├── csv_io.py         # parse_usage_csv / render_usage_csv
│   ├── routes/           # health, pages, usage, settings_ui, data (JSON), csv_routes
│   ├── templates/        # base, dashboard, accruals, usage, projection, settings, import
│   │                     # + partials: _stat_cards, _usage_rows, _usage_row, _usage_edit_row,
│   │                     #   _accrual_rows, _projection_result, _holiday_rows, _tier_rows, _import_preview
│   └── static/           # pico.min.css, app.css, htmx.min.js, chart.umd.min.js, dashboard.js (vendored)
├── tests/                # conftest, test_periods, test_engine, test_usage_api, test_csv,
│                         # test_settings, test_chart_api + fixtures/usage_export.csv (user-provided)
└── data/                 # gitignored; epoch.db
```

## DB schema (`models.py`)

```python
class UsageType(StrEnum): pto = "pto"; personal_holiday = "personal_holiday"

class UsageEntry(SQLModel, table=True):
    id: int | None (pk); date: date (index); hours: float = 8.0
    type: UsageType = pto; reason: str | None; requested: bool = False   # entered in HR system?
    created_at: datetime; updated_at: datetime | None

class CompanyHoliday(SQLModel, table=True):
    id: int | None (pk); date: date (unique); name: str

class AccrualTier(SQLModel, table=True):
    id: int | None (pk); starts_on: date (unique)   # 2023-01-09 / 2028-01-09 / 2033-01-09
    annual_days: float; annual_hours: float          # 22/176, 27/216, 32/256 (hours authoritative)
    label: str

class AppSetting(SQLModel, table=True):
    key: str (pk); value: str    # parsed by domain.load_engine_config
```

Seeded `AppSetting` keys: `hire_date=2023-01-09`, `period_length_days=14`, `pay_date_offset_days=5`, `periods_per_year=26`, `hours_per_day=8`, `max_balance_hours=360`, `rollover_hours=240`, `ph_annual_hours=16`, `projection_horizon_months=18`, `round_period_accrual=true`. Seed the three tiers and a starter company-holiday list (typical US corporate holidays for the current + next year; user edits in settings).

## Accrual engine (`engine.py`) — the heart of the app

**Compute on the fly; never persist derived rows.** The ledger is a deterministic fold over ~hundreds of usage rows × ~150 periods — microseconds. Persisting would create cache-invalidation on every usage/settings/holiday/tier edit for zero benefit, and purity makes projection free and testing trivial. No clock reads inside the engine — "today"/"through" are always parameters.

Frozen dataclasses: `Tier(starts_on, annual_hours)`, `EngineConfig` (all seeded constants + `tiers: tuple[Tier,...]`), `UsageItem(date, hours, is_ph)` (decoupled from SQLModel), `PeriodRow(index, start, end, pay_date, accrual, pto_used, ph_used, balance, lost_to_cap, lost_to_rollover, annual_hours)`, `BalanceSnapshot(as_of, period, pto_balance, ph_granted, ph_used, ph_remaining, warnings)`.

Functions: `period_index_for(cfg, d)`, `period_bounds(cfg, index)`, `accrual_rate(cfg, period_end)`, `compute_ledger(cfg, usage, through) -> list[PeriodRow]`, `balance_on(cfg, usage, on) -> BalanceSnapshot`, `yearly_stats(cfg, usage, through)`.

**Per-period order of operations (document in module docstring — this is the contract):**
```
prev = balance after previous period (0.0 before period 1)
1. ROLLOVER — if period straddles Jan 1 (start.year < end.year):
     lost_to_rollover = max(0, prev - rollover_hours);  prev = min(prev, rollover_hours)
2. ACCRUE + USE, then CAP:
     pto_used = Σ non-PH usage hours with start ≤ date ≤ end
     gross    = prev + accrual_rate(cfg, end) - pto_used
     balance  = round(min(gross, max_balance_hours), 2);  lost_to_cap = max(0, gross - balance)
3. PH — parallel calendar-year bucket, never touches the PTO fold:
     ph_remaining(year) = ph_annual_hours - Σ PH hours in that year (display-clamp at 0)
```
Subtracting usage before capping means usage inside a capped period frees headroom (prev 360, use 8, accrue 6.77 → 358.77) — matching "usage brings it back down; no retroactive credit."

**`balance_on(d)` semantics (matches the sheet):** the end-of-period balance of the period *containing* `d` — includes that whole period's accrual and usage. Label it "reflects the pay period in progress."

**Edge-case decisions:** usage before hire date → 400 at API layer, `ValueError` in engine. Usage exceeding balance → **allowed**, balance goes negative, rendered red + warning (HR systems advance PTO; recording reality wins). Multiple entries on one date are summed; PTO+PH same date go to separate buckets. Weekend/holiday-dated entries (only creatable via manual edit) are just summed — no special casing. Default horizon: today + 18 months; projection extends `through` as needed.

## Routes

**Pages** (`pages.py`): `GET /` dashboard · `/accruals` · `/usage` · `/projection` · `/settings` · `/import` · `GET /healthz` (JSON, for compose healthcheck).

**HTMX** (`usage.py`, `settings_ui.py`):
- `POST /usage` — range form (start, end, type, reason, requested) → `domain.expand_range` skips Sat/Sun + company holidays → N per-day rows (default 8 h, editable after). Weekend/holiday-only range → 400 with message.
- `GET /usage/rows` (filters: type/year/requested → re-render tbody) · `GET /usage/{id}/edit` + `POST /usage/{id}` (inline edit row swap) · `POST /usage/{id}/requested` (checkbox toggle) · `DELETE /usage/{id}` (`hx-swap="delete"`).
- `GET /projection/result?date=` → `_projection_result.html`: `balance_on` snapshot + warnings (scan ledger rows between today and target for `lost_to_cap`/`lost_to_rollover` > 0).
- `POST /settings` (validated constants) · holiday add/delete · tier add/edit/delete → row partials.

**JSON** (`data.py`, consumed by `dashboard.js`): `GET /api/chart?start=&end=` → `{labels, balance[], pto_used[], ph_used[], max_accrued, cap, today_index}` (server does all math; presets YTD/1yr/all/custom are just query params). `GET /api/stats` → per-year totals (accrued, PTO used, PH used, lost_to_cap, lost_to_rollover).

**CSV** (`csv_routes.py`): `POST /import/csv` (multipart) → preview partial (parsed rows, validation errors, mode choice) → confirm. Primary mode **replace-all** (destructive, confirm checkbox — truly idempotent/re-runnable); merge-skip-duplicates on (date, type, hours) as nice-to-have. Columns `Date, Hours, Type, Reason, Requested`; accept `M/D/YYYY` + ISO dates, case-insensitive type mapping ("Personal Holiday" → `personal_holiday`), Yes/No/TRUE/FALSE. **Skip rows with `Hours == 0`** — the sheet pads ranges with 0-hour weekend rows; they're not usage. `GET /export/csv` streams the same format (backup).

## Frontend

- `base.html`: Pico.css (classless) + `app.css` (~150 lines: stat cards, row-state colors) + htmx, nav (Dashboard · Accruals · Usage · Projection · Settings · Import).
- **Dashboard**: stat cards (current PTO balance, PH remaining, max balance ever, % of cap, hours used YTD, next pay date + accrual amount — all from one `compute_ledger` call) + `<canvas>` chart with range preset buttons. Chart mirrors `chart.png`: x = period start dates; PTO Balance line (blue), PTO Used bars (red), PH Used bars (light red), Max-Accrued dashed line (green), optional 360-cap line (off by default — it dwarfs the data), "today" vertical band. Implement the band/lines as a ~15-line inline Chart.js plugin in `dashboard.js` (avoids another vendored plugin). **Load the `dataviz` skill before writing chart code.**
- **Accruals table**: one row per period (#, start, end, pay date, rate, PTO used, PH used, balance, lost badge when > 0); row classes `period-past` / `period-current` / `period-future` (future muted, current highlighted — like the sheet's greyed future rows).
- **Usage table**: filter bar via `hx-get`, new-entry range form on top, past/future row classes, requested flag as HTMX checkbox, inline edit/delete.

## Testing (engine is ~70% of the value)

`conftest.py` mirrors fetch (tmp_path settings/db/`TestClient(create_app(...))`), plus a no-DB `cfg` fixture with seeded defaults.

- **`test_periods.py`**: period 1 = (2023-01-09, 2023-01-22, 2023-01-27); period 92 = (2026-07-06, 2026-07-19, 2026-07-24); `period_index_for(2026-07-08)==92`; boundaries 07-05→91 / 07-06→92 / 07-19→92 / 07-20→93; pre-hire raises; period 104 straddles New Year.
- **`test_engine.py`**:
  - Rates 6.77/8.31/9.85; tier boundary period 130 vs 131.
  - **Sheet regression**: fold from 111.38 with usage {8 h in 3rd period, 16 h in 6th} replays 118.15, 124.92, 123.69, 130.46, 137.23, 128.00, **134.77** exactly.
  - **Golden CSV acceptance test**: if `tests/fixtures/usage_export.csv` exists (user drops in the real sheet export), assert `balance_on(2026-07-08).pto_balance == 134.77` and max balance == 137.23; `skipif` when absent.
  - Cap: 358 + 6.77 → 360.00 with `lost_to_cap==4.77`; capped 360 with 8 h used → 358.77; lost hours never recovered.
  - Rollover: 250 entering the straddling period → 240, `lost_to_rollover==10`; 239 untouched; rollover+cap compose.
  - PH: 16/yr, independent of PTO fold, clamps at 0, resets each year. Negative balances warn. Same-date summing. Projection warnings appear when a span contains lost hours. Determinism (no clock reads).
- **`test_usage_api.py`**: Mon–Sun range with a Wednesday holiday → 4 rows × 8 h; weekend-only → 400; toggle/edit/delete; pre-hire rejected.
- **`test_csv.py`**: sheet export format parses; 0-hour rows skipped; replace-mode idempotent; export→import round-trips.
- **`test_settings.py`**: seed idempotent, user edits survive; raising cap reduces `lost_to_cap`.
- **`test_chart_api.py`**: shape + range filtering; each page returns 200 with its key element.

## Deploy

Dockerfile = fetch's minus ffmpeg (keep curl, gosu, uv-from-image, non-root 1000:1000, `/data`); `CMD uvicorn epoch.main:app --host 0.0.0.0 --port 8000`. Compose: `127.0.0.1:${EPOCH_PORT:-8193}:8000`, `./data:/data`, PUID/PGID, `/healthz` healthcheck, `mem_limit: 512m`, `cpus: 1`. README documents `tailscale serve --bg --https=443 http://127.0.0.1:8193`.

## Execution mode

Per the user: implementation is delegated to **Opus 4.8 subagents** (Agent tool, `model: "opus"`), not done directly by Fable — Fable only orchestrates, reviews gate criteria between phases, and steps in only if absolutely necessary. Run phases sequentially (each depends on the previous); give each agent the full `IMPLEMENTATION.md` plus its phase scope.

## Phase order & verification

1. **Scaffold**: git init, pyproject, package skeleton, `db.py` port, models, seed, `/healthz`. Verify: `uv sync && uv run pytest`; `uv run uvicorn epoch.main:app` + `curl localhost:8000/healthz`.
2. **Engine** (`engine.py`, `test_periods.py`, `test_engine.py`). **Gate: do not proceed until the 134.77 sheet regression passes.**
3. **Usage CRUD + CSV** (`domain.py`, `csv_io.py`, routes + tests). Gate: golden CSV test green against the real export (ask user to export the sheet's usage columns to `tests/fixtures/usage_export.csv`).
4. **Pages**: base template, accruals + usage tables with HTMX inline edit.
5. **Dashboard**: stat cards, `/api/chart`, vendored Chart.js/htmx/Pico downloaded into `static/`, `dashboard.js`.
6. **Projection + stats + settings pages.**
7. **Docker**: `docker compose build && up -d`, healthcheck green, import real CSV through the UI, eyeball chart against `chart.png` (balance dips to ~51 after the Aug 2026 cruise, recovers linearly).

End-to-end acceptance: dashboard shows Current PTO 134.77 / Max 137.23 as of 2026-07-08 with the real data imported; projection for a 2027 date shows growth at 6.77/period and flags any cap/rollover losses.
