# syntax=docker/dockerfile:1
# ServerSherpa API image — the API (uvicorn), every worker, and the
# one-shot `migrate` job all run THIS image with a different command
# (deploy/stack/api/compose.yml). Build context is the REPO ROOT:
#
#   - the report and label workers shell out to Node renderers that are
#     bundled from portal/src (vite SSR builds with noExternal, so the
#     bundles need no node_modules at runtime) — built in the first stage
#     and wired up through SS_REPORT_*_RENDERER, because the package's
#     own <repo>/portal/dist-node fallback doesn't exist once installed;
#   - the wiki worker needs LibreOffice + poppler (previews, search text)
#     and pango (WeasyPrint exports) — the same packages as
#     wiki/Dockerfile.worker, which this image supersedes in the stack;
#   - the db-testing worker runs pg_dump/psql (Debian's client dumps the
#     stack's Postgres 16 fine);
#   - `migrate` runs Alembic from /app/api, so alembic.ini and
#     migrations/ ship with the image.
#
#   docker build -f api/Dockerfile -t serversherpa-api .
#   docker run --rm serversherpa-api serversherpa --help

# The renderers are plain JS: build them on the build machine's own
# platform so a cross-platform build only emulates the Python stage.
FROM --platform=$BUILDPLATFORM node:20-alpine AS renderers
WORKDIR /app
COPY portal/package.json portal/package-lock.json ./portal/
# --legacy-peer-deps: the lockfile omits the optional esbuild peer of
# vitest's nested vite 8, which strict `npm ci` rejects as out of sync
RUN npm ci --prefix portal --ignore-scripts --legacy-peer-deps
COPY portal ./portal
RUN npm --prefix portal run build:rack-renderer \
 && npm --prefix portal run build:container-labels

# trixie, pinned: its nodejs is 20.x (bookworm's is 18, too old for the
# renderers' node20 target)
FROM python:3.13-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/home/serversherpa \
    SS_REPORT_RACK_RENDERER=/app/renderers/render-rack.js \
    SS_REPORT_CONTAINER_LABEL_RENDERER=/app/renderers/render-container-labels.js
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils \
      fonts-dejavu libpango-1.0-0 libpangoft2-1.0-0 \
      nodejs postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api ./api-src
RUN pip install --no-cache-dir ./api-src \
 && mkdir -p /app/api \
 && cp -r api-src/alembic.ini api-src/migrations /app/api/ \
 && rm -rf api-src
COPY --from=renderers /app/portal/dist-node /app/renderers
# LibreOffice needs a writable HOME for its per-run profile
RUN useradd --system --create-home --uid 10001 --home-dir /home/serversherpa serversherpa
USER serversherpa
EXPOSE 8000
# No --forwarded-allow-ips: trusting "*" would let any caller pick its client
# IP (and dodge per-IP rate limits) via X-Forwarded-For; uvicorn reads
# FORWARDED_ALLOW_IPS instead, which the stack sets to the proxy's IP.
CMD ["uvicorn", "serversherpa.api.app:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
