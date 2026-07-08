# epoch

Self-hosted PTO tracker — a replacement for a biweekly-accrual PTO spreadsheet,
served on a tailnet. Server-rendered FastAPI + Jinja2 + HTMX, SQLite, single
Docker container fronted by `tailscale serve`.

See `IMPLEMENTATION.md` for the full design and phase plan.

## Development

```sh
uv sync
uv run pytest
uv run uvicorn epoch.main:app --port 8000
```

`GET /healthz` returns liveness/version JSON.
