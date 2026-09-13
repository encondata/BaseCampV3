# syntax=docker/dockerfile:1
# ServerSherpa kiosk (web mode). Build context is the REPO ROOT: the
# kiosk imports stylesheets and React-free helpers from portal/src via
# its @portal alias, and those files resolve their own dependencies
# (gsap) from portal/node_modules.
#
#   docker build -f kiosk/Dockerfile -t serversherpa-kiosk .
#   docker run -p 8090:8080 -e KIOSK_API_URL=http://localhost:8000 \
#       -e KIOSK_PORTAL_URL=http://localhost:5173 serversherpa-kiosk

FROM node:20-alpine AS build
ARG KIOSK_VERSION=0.0.0
WORKDIR /app
COPY portal/package.json portal/package-lock.json ./portal/
COPY kiosk/package.json kiosk/package-lock.json ./kiosk/
RUN npm ci --prefix portal --ignore-scripts && npm ci --prefix kiosk --ignore-scripts
COPY portal/src ./portal/src
COPY kiosk ./kiosk
ENV VITE_KIOSK_VERSION=$KIOSK_VERSION
RUN npm --prefix kiosk run build

FROM caddy:2-alpine
COPY --from=build /app/kiosk/dist /srv
COPY kiosk/docker/Caddyfile /etc/caddy/Caddyfile
COPY kiosk/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
