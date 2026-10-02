#!/bin/sh
# BaseCamp router agent installer for GL.iNet (OpenWrt) routers.
# Run on the router over SSH:
#   curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --api https://<api-host>
#
#   --api URL            BaseCamp API address (https:// only; kept on re-install)
#   --interval SECONDS   report interval, 60 or more (default 300)
#   --ref REF            git branch or tag to install from (default main)
#   --source BASEURL     install from another location (testing)
#   --uninstall          remove the agent (add --keep-secret to keep its identity)
#
# Everything runs from main() at the bottom, so `curl ... | sh` has read the
# whole script before anything executes, and no command can eat the rest of
# the script from stdin.
set -u

REF=main
SOURCE=""
API=""
INTERVAL=""
UNINSTALL=0
KEEP_SECRET=0
BIN=/usr/bin/basecamp-router
INIT=/etc/init.d/basecamp-router
CONFIG=/etc/config/basecamp
SECRET_DIR=/etc/basecamp
SECRET=$SECRET_DIR/secret
KEEP_LIST=/etc/sysupgrade.conf
KEEP_FILES="/etc/basecamp/ $CONFIG $BIN $INIT"
HEX64='^[0-9a-f]{64}$'

say() { echo "basecamp: $*"; }
die() { echo "basecamp: error: $*" >&2; exit 1; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --api|--interval|--ref|--source)
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --api) API=$2 ;;
          --interval) INTERVAL=$2 ;;
          --ref) REF=$2 ;;
          --source) SOURCE=$2 ;;
        esac
        shift ;;
      --uninstall) UNINSTALL=1 ;;
      --keep-secret) KEEP_SECRET=1 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  [ -n "$SOURCE" ] || SOURCE="https://raw.githubusercontent.com/encondata/BaseCampV3/$REF/router_agent"
  SOURCE=${SOURCE%/}
}

drop_keep_lines() {
  [ -f "$KEEP_LIST" ] || return 0
  tmp="$KEEP_LIST.basecamp.$$"
  cp "$KEEP_LIST" "$tmp" || return 0
  for f in $KEEP_FILES; do
    [ "$KEEP_SECRET" = 1 ] && [ "$f" = /etc/basecamp/ ] && continue
    grep -vxF "$f" "$tmp" > "$tmp.n"
    mv "$tmp.n" "$tmp"
  done
  cat "$tmp" > "$KEEP_LIST"
  rm -f "$tmp"
}

uninstall() {
  if [ -x "$INIT" ]; then
    "$INIT" stop >/dev/null 2>&1 </dev/null
    "$INIT" disable >/dev/null 2>&1 </dev/null
  fi
  rm -f /etc/rc.d/S??basecamp-router /etc/rc.d/K??basecamp-router
  rm -f "$BIN" "$INIT" "$CONFIG"
  if [ "$KEEP_SECRET" = 1 ]; then say "kept $SECRET"; else rm -rf "$SECRET_DIR"; fi
  drop_keep_lines
  say "uninstalled"
}

fetch() {  # url dest
  curl -fsSL "$1" -o "$2.new" </dev/null || { rm -f "$2.new"; die "couldn't download $1"; }
  [ -s "$2.new" ] || { rm -f "$2.new"; die "downloaded an empty file from $1"; }
  chmod 755 "$2.new" && mv "$2.new" "$2" || die "couldn't install $2"
}

write_config() {
  [ -f "$CONFIG" ] || : > "$CONFIG"
  uci -q get basecamp.agent >/dev/null || uci set basecamp.agent=agent
  uci set basecamp.agent.api_url="$API"
  if [ -n "$INTERVAL" ]; then
    uci set basecamp.agent.interval="$INTERVAL"
  elif [ -z "$(uci -q get basecamp.agent.interval)" ]; then
    uci set basecamp.agent.interval=300
  fi
  uci set basecamp.agent.enabled=1
  uci commit basecamp || die "couldn't save $CONFIG"
}

# The secret is this router's identity together with its WAN MAC: made
# once, kept across re-installs and firmware upgrades, never printed and
# never sent anywhere but the BaseCamp API.
make_secret() {
  old_umask=$(umask)
  umask 077
  mkdir -p "$SECRET_DIR" && chmod 700 "$SECRET_DIR" || die "couldn't create $SECRET_DIR"
  if ! grep -qE "$HEX64" "$SECRET" 2>/dev/null; then
    # BusyBox hexdump on stock firmware; sha256sum of 64 random bytes if a
    # build leaves hexdump out (OpenWrt's BusyBox has no od)
    hexdump -v -n 32 -e '/1 "%02x"' /dev/urandom > "$SECRET.new" 2>/dev/null
    grep -qE "$HEX64" "$SECRET.new" 2>/dev/null \
      || head -c 64 /dev/urandom | sha256sum | cut -c1-64 > "$SECRET.new"
    grep -qE "$HEX64" "$SECRET.new" || { rm -f "$SECRET.new"; die "couldn't generate a secret"; }
    chmod 600 "$SECRET.new" && mv "$SECRET.new" "$SECRET" || die "couldn't save $SECRET"
    say "generated this router's secret ($SECRET)"
  fi
  chmod 600 "$SECRET"
  umask "$old_umask"
}

add_keep_lines() {
  touch "$KEEP_LIST"
  for f in $KEEP_FILES; do
    grep -qxF "$f" "$KEEP_LIST" || echo "$f" >> "$KEEP_LIST"
  done
}

install_agent() {
  command -v curl >/dev/null 2>&1 || die "curl is required: opkg update && opkg install curl"

  [ -n "$API" ] || API=$(uci -q get basecamp.agent.api_url)
  case "$API" in
    https://?*) ;;
    '') die "--api https://<api-host> is required" ;;
    *) die "the API address must start with https:// (got $API)" ;;
  esac
  API=${API%/}
  if [ -n "$INTERVAL" ]; then
    case "$INTERVAL" in *[!0-9]*) die "--interval must be a number of seconds" ;; esac
    INTERVAL=${INTERVAL#"${INTERVAL%%[!0]*}"}
    [ "${INTERVAL:-0}" -ge 60 ] || die "--interval must be at least 60 seconds"
  fi

  say "downloading the agent from $SOURCE"
  fetch "$SOURCE/basecamp-router.sh" "$BIN"
  fetch "$SOURCE/basecamp-router.init" "$INIT"
  write_config
  make_secret
  add_keep_lines

  "$INIT" stop >/dev/null 2>&1 </dev/null
  say "sending a first report to $API"
  "$BIN" once </dev/null || say "the first report didn't go through; the service keeps retrying (logread -e basecamp)"
  "$INIT" enable </dev/null || say "warning: couldn't enable the service at boot"
  "$INIT" start >/dev/null 2>&1 </dev/null || say "warning: couldn't start the service; run $INIT start"

  say "installed. This router registers with WAN MAC $("$BIN" mac 2>/dev/null </dev/null || echo unknown)."
  say "Approve it in the portal: Scanning Hardware › Routers (or from the approval notification)."
}

main() {
  parse_args "$@"
  [ -f /etc/openwrt_release ] || die "this doesn't look like an OpenWrt / GL.iNet router"
  [ "$(id -u)" = 0 ] || die "run this as root"
  if [ "$UNINSTALL" = 1 ]; then uninstall; else install_agent; fi
}

main "$@"
