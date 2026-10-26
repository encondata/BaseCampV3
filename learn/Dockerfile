# syntax=docker/dockerfile:1
# ServerSherpa learn site (learn.<domain>): the worker training SPA,
# served by Caddy. Build context is the REPO ROOT: the app imports
# stylesheets, React-free helpers and the allowlisted sign-in modules from
# portal/src through its @portal alias. As in the kiosk image, that shared
# source is bundled with the learn app's own npm dependencies (vite.config.ts
# dedupes React, the router, gsap and bwip-js to its copies;
# web/src/portalImports.test.ts keeps that list complete), so portal's own
# node_modules are never installed here. Type-checking (`tsc` in
# `npm run build`) happens outside the image; inside it, `build:bundle`
# runs `vite build` only.
#
#   docker build -f learn/Dockerfile -t serversherpa-learn .
#   docker run -p 8092:8080 -e LEARN_API_URL=http://localhost:8000 serversherpa-learn

FROM node:20-alpine AS build
WORKDIR /app
COPY learn/package.json learn/package-lock.json ./learn/
RUN npm ci --prefix learn --ignore-scripts
COPY portal/src ./portal/src
COPY portal/public ./portal/public
COPY learn ./learn
RUN npm --prefix learn run build:bundle

FROM caddy:2-alpine
COPY --from=build /app/learn/dist /srv
COPY learn/docker/Caddyfile /etc/caddy/Caddyfile
COPY learn/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
