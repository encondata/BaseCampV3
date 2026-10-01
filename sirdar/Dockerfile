# Sirdar — one image: the FastAPI app serves /api and the built SPA.
# Build context is the REPO ROOT (the SPA imports portal/src + portal/public):
#   docker build -f sirdar/Dockerfile -t sirdar .
FROM node:20-alpine AS web
WORKDIR /app
COPY sirdar/web/package.json sirdar/web/package-lock.json ./sirdar/web/
RUN npm ci --prefix sirdar/web
COPY portal/src ./portal/src
COPY portal/public ./portal/public
COPY sirdar/web ./sirdar/web
# Vite only: `npm run build` also type-checks, which needs portal/node_modules
# (not in this image); CI and local builds type-check, vite dedupes the rest.
RUN cd sirdar/web && npx vite build

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 SIRDAR_STATIC_DIR=/app/static
WORKDIR /app/api
COPY sirdar/api/pyproject.toml ./
COPY sirdar/api/src ./src
RUN pip install --no-cache-dir .
COPY sirdar/api/alembic.ini ./
COPY sirdar/api/migrations ./migrations
COPY --from=web /app/sirdar/web/dist /app/static
COPY sirdar/docker-entrypoint.sh /usr/local/bin/sirdar-entrypoint
RUN chmod 755 /usr/local/bin/sirdar-entrypoint && useradd --system --uid 10001 sirdar
USER sirdar
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
ENTRYPOINT ["sirdar-entrypoint"]
CMD ["serve"]
