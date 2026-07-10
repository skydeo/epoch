# --------------------------------------------------------------------------- #
# Stage 1: build the SPA (Vite React TS) to web/dist
# --------------------------------------------------------------------------- #
FROM node:22-alpine AS web-build

WORKDIR /web

# Install deps first for layer caching; the lockfile pins the exact tree.
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

# --------------------------------------------------------------------------- #
# Stage 2: the Python runtime image
# --------------------------------------------------------------------------- #
# python:3.14-slim (bump to 3.15-slim after Oct 2026 once cp315 wheels land).
FROM python:3.14-slim

# curl backs the compose healthcheck; gosu drops privileges to the PUID/PGID
# user set at runtime by the entrypoint.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gosu \
    && rm -rf /var/lib/apt/lists/*

# uv for dependency install
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install dependencies first for better layer caching
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --frozen --no-install-project || uv sync --no-dev

# Copy application code + the built SPA (served by the StaticFiles mount,
# which resolves web/dist relative to the epoch package: /app/web/dist).
COPY epoch ./epoch
COPY --from=web-build /web/dist ./web/dist

# Non-root runtime user. Created at a default 1000:1000; the entrypoint remaps
# it to the runtime PUID/PGID and then drops to it via gosu. Image files stay
# world-readable, so the user can read /app regardless of the final UID.
RUN groupadd -g 1000 epoch \
    && useradd -u 1000 -g epoch -d /app -s /usr/sbin/nologin epoch \
    && mkdir -p /data \
    && chown epoch:epoch /data

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "epoch.main:app", "--host", "0.0.0.0", "--port", "8000"]
