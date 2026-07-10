"""FastAPI application factory and lifespan.

The lifespan initializes the SQLite database (WAL) and seeds idempotent default
settings/tiers/holidays before serving. There is no worker pool, auth, or
background processing — epoch is a single-user, read-mostly app whose only real
work (the accrual fold) happens synchronously per request in the pure engine.

The built SPA (``web/dist``) is served by a ``StaticFiles`` mount at ``/``
registered *after* the API routers, so ``/api/*``, ``/export/csv``, and
``/healthz`` always win. Deep links (``/usage``, ``/accruals``, …) don't map to
files on disk, so the mount falls back to ``index.html`` and the client router
takes over. The mount is skipped (with a warning) when ``web/dist`` is absent —
dev servers and pytest don't require a frontend build.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.types import Scope

from epoch import __version__
from epoch.config import Settings, get_settings
from epoch.db import get_session, init_db
from epoch.routes import api, csv_routes, data, health
from epoch.seed import seed_defaults

logger = logging.getLogger("epoch")

# The Vite build output, one level above the package: <repo>/web/dist. The
# Docker image copies it to the same relative spot (/app/web/dist).
WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"

# Prefixes owned by the backend: a miss under these must 404, never fall back
# to the SPA's index.html.
_BACKEND_PREFIXES = ("api/", "export/", "healthz")


class SPAStaticFiles(StaticFiles):
    """``StaticFiles(html=True)`` with an ``index.html`` fallback for deep links.

    Real files (hashed assets, index.html itself) are served as usual; any
    other path — a client-side route like ``/usage`` — falls through to
    ``index.html`` so a hard refresh or a shared link lands in the SPA. Paths
    under the backend prefixes keep their 404 so a bad API call never receives
    an HTML page.
    """

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            if exc.status_code == 404 and not path.startswith(_BACKEND_PREFIXES):
                return await super().get_response("index.html", scope)
            raise


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
    app.include_router(data.router)
    app.include_router(api.router)
    app.include_router(csv_routes.router)

    # Mounted last so every registered route above wins over the catch-all.
    if WEB_DIST.is_dir():
        app.mount("/", SPAStaticFiles(directory=str(WEB_DIST), html=True), name="spa")
    else:
        logger.warning(
            "SPA build not found at %s — serving API only. "
            "Run `cd web && npm run build` to build the frontend.",
            WEB_DIST,
        )
    return app


app = create_app()
