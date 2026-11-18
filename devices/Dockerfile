# The devices service — one image: the FastAPI app serves /api, the install
# routes and the built web app on :8080; `worker` runs the background jobs.
# Build context is the REPO ROOT (the web app imports portal/src + portal/public):
#   docker build -f devices/Dockerfile -t serversherpa-devices .
FROM node:20-alpine AS web
WORKDIR /app
COPY devices/web/package.json devices/web/package-lock.json ./devices/web/
RUN npm ci --prefix devices/web
COPY portal/src ./portal/src
COPY portal/public ./portal/public
COPY devices/web ./devices/web
# Vite only: `npm run build` also type-checks, which needs portal/node_modules
# (not in this image); CI and local builds type-check, vite dedupes the rest.
RUN cd devices/web && npx vite build

# rcodesign (iOS re-signing), the release's static musl build, pinned and
# checked against the SHA-256 sums the release publishes in SHA256SUMS:
# https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F0.29.0/SHA256SUMS
# Bump the version and both sums together.
FROM python:3.13-slim AS rcodesign
ARG TARGETARCH
ARG RCODESIGN_VERSION=0.29.0
ARG RCODESIGN_SHA256_AMD64=dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002
ARG RCODESIGN_SHA256_ARM64=4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) arch=x86_64; sha="$RCODESIGN_SHA256_AMD64" ;; \
      arm64) arch=aarch64; sha="$RCODESIGN_SHA256_ARM64" ;; \
      *) echo "no pinned rcodesign for ${TARGETARCH:-this architecture}" >&2; exit 1 ;; \
    esac; \
    name="apple-codesign-${RCODESIGN_VERSION}-${arch}-unknown-linux-musl"; \
    curl -fsSLo /tmp/rcodesign.tar.gz \
      "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/${name}.tar.gz"; \
    echo "${sha}  /tmp/rcodesign.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/rcodesign.tar.gz -C /tmp "${name}/rcodesign"; \
    install -m 755 "/tmp/${name}/rcodesign" /usr/local/bin/rcodesign

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    DEVICES_STATIC_DIR=/app/static DEVICES_RCODESIGN_PATH=/usr/local/bin/rcodesign \
    HOME=/home/devices
WORKDIR /app/api
COPY devices/api/pyproject.toml ./
COPY devices/api/src ./src
RUN pip install --no-cache-dir .
COPY devices/api/alembic.ini ./
COPY devices/api/migrations ./migrations
COPY --from=web /app/devices/web/dist /app/static
COPY --from=rcodesign /usr/local/bin/rcodesign /usr/local/bin/rcodesign
COPY devices/docker-entrypoint.sh /usr/local/bin/devices-entrypoint
RUN chmod 755 /usr/local/bin/devices-entrypoint \
 && useradd --system --uid 10001 --create-home --home-dir /home/devices devices \
 && chown devices:devices /home/devices && chmod 700 /home/devices
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"
ENTRYPOINT ["devices-entrypoint"]
CMD ["serve"]
