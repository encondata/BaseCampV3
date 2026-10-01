#!/bin/sh
# Builds the laptop image and checks it against an unreachable cloud:
# the app is served, config.js says laptop, the identity is fixed across a
# restart, offline sign-in with no cached verifier is a clean 401, a path
# escape is a 404, a foreign Host header is a 400, and the container
# reports healthy.
set -eu
cd "$(dirname "$0")/../.."
IMAGE=serversherpa-kiosk-laptop:smoke
DATA=$(mktemp -d)
NAME=kiosk-laptop-smoke
docker build -q -f kiosk_laptop/Dockerfile -t "$IMAGE" . >/dev/null
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT
start() {
  docker run -d --name "$NAME" -p 127.0.0.1:18090:8090 -v "$DATA:/data" \
    -e EDGE_CLOUD_API_URL=http://127.0.0.1:9 "$IMAGE" >/dev/null
  for _ in $(seq 1 30); do curl -fs http://127.0.0.1:18090/edge/identity >/dev/null && return; sleep 1; done
  echo "edge did not start"; docker logs "$NAME"; exit 1
}
start
curl -fs http://127.0.0.1:18090/ | grep -q '<div id="root">' || { echo "index not served"; exit 1; }
curl -fs http://127.0.0.1:18090/config.js | grep -q '"mode": "laptop"' || { echo "config.js wrong"; exit 1; }
SERIAL=$(curl -fs http://127.0.0.1:18090/edge/identity | sed 's/.*"serial":"\([^"]*\)".*/\1/')
case "$SERIAL" in kiosk-laptop-*) ;; *) echo "bad serial $SERIAL"; exit 1;; esac
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' \
  -d '{"email":"a@b.c","password":"x"}' http://127.0.0.1:18090/auth/login)
[ "$CODE" = 401 ] || { echo "offline login answered $CODE"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is http://127.0.0.1:18090/kiosk/%2e%2e/admin/users)
[ "$CODE" = 404 ] || { echo "path escape answered $CODE"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' http://127.0.0.1:18090/edge/identity)
[ "$CODE" = 400 ] || { echo "foreign Host answered $CODE"; exit 1; }
HEALTH=
for _ in $(seq 1 30); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$HEALTH" = healthy ] && break
  sleep 1
done
[ "$HEALTH" = healthy ] || { echo "container health is $HEALTH"; exit 1; }
docker rm -f "$NAME" >/dev/null
start
AGAIN=$(curl -fs http://127.0.0.1:18090/edge/identity | sed 's/.*"serial":"\([^"]*\)".*/\1/')
[ "$AGAIN" = "$SERIAL" ] || { echo "serial changed across restart"; exit 1; }
echo "smoke OK ($SERIAL)"
