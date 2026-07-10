# epoch

A small self-hosted PTO tracker — a replacement for a biweekly-accrual PTO
spreadsheet. It recomputes your paid-time-off balance from first principles on
every request: pay periods are pure 14-day arithmetic anchored at your hire
date, each period accrues at your current tenure tier, and a deterministic fold
over your usage log reproduces the running balance (with the annual rollover
forfeiture and the hard balance cap applied in order). A React + Vite +
TypeScript single-page app (client-side routing, optimistic updates via
TanStack Query, a Chart.js dashboard, and a persisted light/dark theme toggle)
talks to a FastAPI JSON API; the built SPA is served from the same FastAPI
process. SQLite for storage, one Docker container bound to `127.0.0.1` and
fronted by `tailscale serve` — no auth, no accounts, tailnet-only by design.

For the full design rationale and the phase-by-phase build plan, see
[`IMPLEMENTATION.md`](./IMPLEMENTATION.md). This README is the practical "how do
I run and use this" reference.

## Local development

Backend (FastAPI JSON API):

```bash
uv sync                                    # install deps (including dev/test)
uv run pytest                              # run the test suite
export DB_PATH=./data/epoch.db             # default is /data/epoch.db — point it somewhere writable
mkdir -p data
uv run uvicorn epoch.main:app --reload     # http://127.0.0.1:8000
```

Frontend (React + Vite SPA in `web/`):

```bash
cd web
npm install
npm run dev                                # http://localhost:5173
```

The Vite dev server proxies `/api` and `/export` to the FastAPI instance on
`127.0.0.1:8000` (see `web/vite.config.ts`), so run both processes for
full-stack dev with hot reload.

For a production-style single-process run, build the SPA once — FastAPI serves
`web/dist` itself (deep links like `/usage` fall back to `index.html`):

```bash
cd web && npm run build && cd ..
uv run uvicorn epoch.main:app              # SPA + API on http://127.0.0.1:8000
```

If `web/dist` is missing the backend still starts (API only) and logs a
warning — pytest never needs a frontend build.

The database is created and seeded (settings, accrual tiers, a starter US
company-holiday list) automatically on first startup. `GET /healthz` returns
liveness/version JSON.

## Deployment

```bash
cp .env.example .env      # then set PUID/PGID to your host user's `id`, adjust EPOCH_PORT if needed
docker compose up -d --build
curl http://127.0.0.1:8193/healthz     # smoke-test on the host itself
# {"status":"ok","version":"0.1.0"}
```

The image is a multi-stage build: a Node stage compiles the SPA
(`npm ci && npm run build` in `web/`), then the Python stage copies `web/dist`
into the final image — no Node at runtime.

The container publishes to **`127.0.0.1:8193`** by default — host loopback only.
(The app always listens on **8000** *inside* the container; `8193` is just the
host port, set with `EPOCH_PORT` in `.env`. Only the host side ever moves.) The
SQLite database lives in `./data/epoch.db` on the host and survives rebuilds.

The container starts as root just long enough to remap its service user to your
`PUID`/`PGID` and then drops privilege via `gosu`, so the DB file in `./data`
ends up owned by you on the host rather than root — set `PUID`/`PGID` to match
(`id -u` / `id -g`).

### Reach it from your other devices (Tailscale)

The loopback bind means it's deliberately *not* reachable from anywhere but the
host — put `tailscale serve` in front to expose it over HTTPS on your tailnet:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8193
```

It's now at **`https://<machine>.<tailnet>.ts.net/`** from any device on your
tailnet — encrypted, tailnet-only, never on your LAN. `tailscale serve status`
shows what's currently fronted; `tailscale serve --https=443 off` removes it.

## Importing your spreadsheet history

epoch stores your **usage log** (days taken); accruals are recomputed from the
rules, never imported. To seed your history:

1. In the source spreadsheet, export the usage table's columns —
   **Date, Hours, Type, Reason, Requested** — to a CSV. Dates may be `M/D/YYYY`
   or ISO; `Type` is case-insensitive (`PTO` / `Personal Holiday`); `Requested`
   accepts Yes/No/TRUE/FALSE. Rows with `Hours == 0` (weekend padding rows) are
   skipped automatically.
2. Open **`/import`** in the browser, upload the CSV, and confirm. The primary
   mode is **replace-all** (destructive but idempotent — re-running the same
   export converges to the same state).
3. To lock in the acceptance test, drop that same file at
   `tests/fixtures/usage_export.csv` and run `uv run pytest`. The golden
   acceptance test (skipped until the fixture exists) asserts the balance is
   **134.77** on **2026-07-08** and the max balance ever is **137.23**.

`GET /export/csv` streams the same format back out as a backup.

## Settings

All domain constants live in the database as editable rows (seeded on first
run), reachable at **`/settings`**:

- **Accrual constants** — hire date, period length (14 days), pay-date offset,
  periods per year (26), hours per day, the **360 hr** balance cap, the **240 hr**
  year-end rollover forfeiture threshold, annual personal-holiday hours (16), and
  the projection horizon.
- **Accrual tiers** — the tenure schedule (22 days/176 hr now → 27/216 at 5 yrs
  → 32/256 at 10 yrs). A period accrues at the tier whose start date is on or
  before the period's end.
- **Company holidays** — the list used to skip non-working days when expanding a
  usage date range. Add/remove per year.

Edits are preserved across restarts (seeding is insert-if-missing).

## Pages

The UI is a single-page app (client-side routing — no full-page reloads; every
mutation updates in place). A theme toggle in the sidebar persists light/dark
to `localStorage` and applies before first paint, so there is no flash on
reload.

- **`/`** — dashboard: stat cards (current balance, PH remaining, max ever, % of
  cap, YTD used, next pay date + accrual) and the balance chart
  (YTD / 1yr / All ranges, restyled per theme).
- **`/accruals`** — the per-period ledger table with the current period
  highlighted.
- **`/usage`** — the usage log with a range-entry form, filters, and inline
  edit / requested-toggle / delete.
- **`/projection`** — balance on a future date, flagging any cap/rollover loss.
- **`/settings`** — the editable constants above.
- **`/import`** — CSV upload (preview → confirm) and export.
