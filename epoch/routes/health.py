"""Health check endpoint. No auth — used by the docker healthcheck."""

from __future__ import annotations

from fastapi import APIRouter

from epoch import __version__

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness probe. Returns service status and version."""
    return {"status": "ok", "version": __version__}
