# syntax=docker/dockerfile:1
# ServerSherpa public status page. Build context is the REPO ROOT: the page
# imports the portal's stylesheets from portal/src via its @portal alias
# (kiosk/Dockerfile precedent). Only CSS comes from the portal, so portal's
# own node_modules are never installed.
#
#   docker build -f status/Dockerfile -t serversherpa-status .
#   docker run -p 8095:8080 -v status-data:/data \
#       -e STATUS_API_URL=https://api.serversherpa.com \
#       -e STATUS_PORTAL_URL=https://portal.serversherpa.com \
#       -e STATUS_KIOSK_URL=https://kiosk.serversherpa.com serversherpa-status

FROM node:20-alpine AS web
WORKDIR /app
COPY status/web/package.json status/web/package-lock.json ./status/web/
RUN npm ci --prefix status/web --ignore-scripts
COPY portal/src/styles ./portal/src/styles
COPY status/web ./status/web
RUN npm --prefix status/web run build:bundle

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    STATUS_DB_PATH=/data/status.db STATUS_STATIC_DIR=/app/static PORT=8080
WORKDIR /app
COPY status/pyproject.toml ./
COPY status/src ./src
RUN pip install --no-cache-dir . && rm -rf src pyproject.toml build
COPY --from=web /app/status/web/dist /app/static
RUN useradd --system --uid 10001 status && mkdir -p /data && chown status /data
USER status
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
CMD ["python", "-m", "serversherpa_status"]
