"""Shared Jinja2 templates instance.

Set up once here (mirroring ``fetch``'s ``Jinja2Templates`` usage) and imported
by every route module that renders HTML. Phase 4 extends the same instance /
directory with the full page templates and a base layout; the Phase 3 routes
only ship the bare HTMX partials they need to render.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.templating import Jinja2Templates

# Templates live under epoch/templates/ (§16). Configured at import time; the
# app factory just registers routers.
TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
