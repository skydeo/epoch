"""FastAPI application factory and lifespan.

The lifespan initializes the SQLite database (WAL) and seeds idempotent default
settings/tiers/holidays before serving. There is no worker pool, auth, or
background processing — epoch is a single-user, read-mostly app whose only real
work (the accrual fold) happens synchronously per request in the pure engine.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from epoch import __version__
from epoch.config import Settings, get_settings
from epoch.db import get_session, init_db
from epoch.routes import api, csv_routes, data, health, pages, settings_ui, usage
from epoch.seed import seed_defaults

STATIC_DIR = Path(__file__).resolve().parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialize the DB and seed defaults, then serve."""
    settings: Settings = app.state.settings
    init_db(settings)
    with get_session() as session:
        seed_defaults(session)
    yield


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build and configure the FastAPI application.

    ``settings`` overrides the env-loaded singleton (used by tests). The
    resolved settings are wired into the ``get_settings`` dependency so routes
    use the same instance.
    """
    settings = settings or get_settings()
    app = FastAPI(
        title="epoch",
        description="Self-hosted PTO tracker",
        version=__version__,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.dependency_overrides[get_settings] = lambda: settings

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    app.include_router(health.router)
    app.include_router(pages.router)
    app.include_router(data.router)
    app.include_router(api.router)
    app.include_router(usage.router)
    app.include_router(settings_ui.router)
    app.include_router(csv_routes.router)
    return app


app = create_app()
