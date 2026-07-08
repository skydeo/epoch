"""FastAPI application factory and lifespan.

The lifespan initializes the SQLite database (WAL) and seeds idempotent default
settings/tiers/holidays before serving. There is no worker pool, auth, or
background processing — epoch is a single-user, read-mostly app whose only real
work (the accrual fold) happens synchronously per request in the pure engine.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from epoch import __version__
from epoch.config import Settings, get_settings
from epoch.db import get_session, init_db
from epoch.routes import health
from epoch.seed import seed_defaults


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

    app.include_router(health.router)
    return app


app = create_app()
