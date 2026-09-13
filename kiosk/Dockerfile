# syntax=docker/dockerfile:1
# ServerSherpa kiosk (web mode). Build context is the REPO ROOT: the
# kiosk imports stylesheets and React-free helpers from portal/src via
# its @portal alias. The image bundles that shared portal source with
# the kiosk's own npm dependencies rather than installing portal's own
# node_modules — the only runtime dependency the shared files pull in is
# gsap, which vite.config.ts dedupes to the kiosk's copy, and every
# other portal import here is CSS or a type-only import that vite erases.
# So the image never runs `npm ci --prefix portal` (portal's lockfile has
# a vitest/vite peer-version conflict that makes `npm ci` refuse it
# entirely, unrelated to the kiosk). Type-checking (`tsc -b`) happens in
# `npm run build` outside the image; inside the image, `build:bundle`
# runs `vite build` only.
#
#   docker build -f kiosk/Dockerfile -t serversherpa-kiosk .
#   docker run -p 8090:8080 -e KIOSK_API_URL=http://localhost:8000 \
#       -e KIOSK_PORTAL_URL=http://localhost:5173 serversherpa-kiosk

FROM node:20-alpine AS build
ARG KIOSK_VERSION=0.0.0
WORKDIR /app
COPY kiosk/package.json kiosk/package-lock.json ./kiosk/
RUN npm ci --prefix kiosk --ignore-scripts
COPY portal/src ./portal/src
COPY kiosk ./kiosk
ENV VITE_KIOSK_VERSION=$KIOSK_VERSION
RUN npm --prefix kiosk run build:bundle

FROM caddy:2-alpine
COPY --from=build /app/kiosk/dist /srv
COPY kiosk/docker/Caddyfile /etc/caddy/Caddyfile
COPY kiosk/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
