# syntax=docker/dockerfile:1
# ServerSherpa kiosk — laptop edition. One process: the edge API (FastAPI +
# SQLite) serving the kiosk bundle and standing between it and the cloud.
# Build context is the REPO ROOT (the kiosk imports portal/src via @portal;
# see kiosk/Dockerfile for why the bundle is built with `vite build` only).
#
#   docker build -f kiosk_laptop/Dockerfile -t serversherpa-kiosk-laptop .
#   docker compose -f kiosk_laptop/docker-compose.yml up -d

FROM node:20-alpine AS web
ARG KIOSK_VERSION=0.0.0
WORKDIR /app
COPY kiosk/package.json kiosk/package-lock.json ./kiosk/
RUN npm ci --prefix kiosk --ignore-scripts
COPY portal/src ./portal/src
COPY kiosk ./kiosk
ENV VITE_KIOSK_VERSION=$KIOSK_VERSION
RUN npm --prefix kiosk run build:bundle

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    EDGE_DATA_DIR=/data EDGE_WEB_DIR=/app/web
WORKDIR /app
COPY kiosk_laptop/edge/pyproject.toml ./edge/pyproject.toml
COPY kiosk_laptop/edge/src ./edge/src
RUN pip install --no-cache-dir ./edge
COPY --from=web /app/kiosk/dist /app/web
EXPOSE 8090
# python's urllib, so the slim image needs no curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/edge/identity', timeout=4)"]
CMD ["uvicorn", "edge.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090"]
