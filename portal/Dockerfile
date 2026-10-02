# syntax=docker/dockerfile:1
# ServerSherpa portal — the SPA (portal/, Vite) served by Caddy. One
# build serves every environment: lib/api.ts and lib/appLinks.ts derive
# the API, kiosk and wiki origins from the page's own hostname
# (portal.uat.serversherpa.com → api.uat.serversherpa.com, see
# lib/siblingOrigin.ts), so nothing environment-specific is baked in and
# no runtime config file is needed. Type-checking (`tsc -b` in
# `npm run build`) happens outside the image, as for the kiosk; the
# rack/label renderers are built into the API image, not here.
#
#   docker build -f portal/Dockerfile -t serversherpa-portal .
#   docker run -p 8091:8080 serversherpa-portal

FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY portal/package.json portal/package-lock.json ./portal/
# --legacy-peer-deps: the lockfile omits the optional esbuild peer of
# vitest's nested vite 8, which strict `npm ci` rejects as out of sync
RUN npm ci --prefix portal --ignore-scripts --legacy-peer-deps
COPY portal ./portal
RUN cd portal && npx vite build

FROM caddy:2-alpine
COPY --from=build /app/portal/dist /srv
COPY portal/docker/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
