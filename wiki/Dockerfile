# syntax=docker/dockerfile:1
# ServerSherpa wiki — the SPA (wiki/web, Vite) served by the wiki/server
# Express app: static files with a history fallback, /healthz,
# /internal/render (page JSON -> HTML for exports), and the /collab
# Hocuspocus WebSocket for live co-editing. Build context is the REPO
# ROOT: the wiki imports stylesheets, React-free helpers, and an
# allowlisted set of portal React modules (the portal's own Login page
# and AuthContext, so sign-in is literally the portal's) from portal/src
# via the @portal alias, and needs portal/public for the images those
# modules load — same trick as kiosk/Dockerfile and status/Dockerfile.
#
# wiki/ is ONE npm package holding both web/ and server/ (so the shared
# editor schema has one copy of @tiptap/*/yjs). `npm run build:bundle`
# builds both halves: `vite build` (the SPA, to wiki/dist) and
# `tsc -p tsconfig.server.json` (the server + shared schema, to
# wiki/dist-server, entry dist-server/server/src/index.js). Full
# type-checking (`tsc -b` in `npm run build`) happens outside the image.
#
#   docker build -f wiki/Dockerfile -t serversherpa-wiki .
#   docker run -p 8096:8080 -e WIKI_API_URL=http://host.docker.internal:8000 \
#       -e WIKI_SERVICE_TOKEN=... serversherpa-wiki

FROM node:20-alpine AS build
WORKDIR /app
COPY wiki/package.json wiki/package-lock.json ./wiki/
RUN npm ci --prefix wiki
COPY portal/src ./portal/src
COPY portal/public ./portal/public
COPY wiki ./wiki
RUN npm --prefix wiki run build:bundle

FROM node:20-alpine AS run
WORKDIR /app
COPY wiki/package.json wiki/package-lock.json ./wiki/
# Server runtime deps (express, @hocuspocus/*, yjs, ws, the @tiptap/*
# packages render.ts uses) live in "dependencies", so --omit=dev is safe.
RUN npm ci --omit=dev --prefix wiki
COPY --from=build /app/wiki/dist ./wiki/dist
COPY --from=build /app/wiki/dist-server ./wiki/dist-server
ENV PORT=8080 WIKI_STATIC_DIR=/app/wiki/dist
WORKDIR /app/wiki
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist-server/server/src/index.js"]
