#!/bin/sh
# Runs the router agent tests inside an OpenWrt rootfs container (real
# BusyBox ash, uci, jsonfilter, jshn). Needs Docker.
#   router_agent/test/run.sh            every suite present (agent, install)
#   router_agent/test/run.sh agent      agent only
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)
# The arm image's manifest names its platform "aarch64_generic" (OpenWrt's
# arch name), which Docker won't match to linux/arm64 by tag alone, so it is
# pinned by the digest of that platform's manifest.
case "$(uname -m)" in
  arm64|aarch64) IMAGE="${OPENWRT_IMAGE:-openwrt/rootfs:armsr-armv8-23.05.5@sha256:f039e07870639d6f6eaf685df286f1130942acfd38cba333be5eaba65a173d74}" ;;
  *) IMAGE="${OPENWRT_IMAGE:-openwrt/rootfs:x86-64-23.05.5}" ;;
esac
suites="${1:-agent install}"
for s in $suites; do
  if [ ! -f "$HERE/test/${s}_test.sh" ]; then
    echo "== $s tests skipped (not present)"
    continue
  fi
  echo "== $s tests ($IMAGE)"
  docker run --rm -v "$HERE:/src:ro" "$IMAGE" /bin/sh "/src/test/${s}_test.sh"
done
