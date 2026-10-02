#!/bin/sh
# BaseCamp router agent installer for GL.iNet (OpenWrt) routers.
# Run on the router over SSH:
#   curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/router_agent/install.sh | sh -s -- --api https://<api-host>
#
#   --api URL            BaseCamp API address (https:// only; kept on re-install)
#   --interval SECONDS   report interval, 60 or more (default 65)
#   --hostname NAME      set the router's hostname without asking (letters,
#                        digits and hyphens, up to 63; the portal names a new
#                        router after it). Without it, the installer asks on
#                        the terminal (60 s per answer), or keeps the current
#                        name if there's none. Unattended or background
#                        installs should pass --hostname, e.g.
#   curl -fsSL .../install.sh | sh -s -- --api https://<api-host> --hostname dock-router-7
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
HOSTNAME_ARG=""
NEW_HOSTNAME=""
UNINSTALL=0
KEEP_SECRET=0
BIN=/usr/bin/basecamp-router
INIT=/etc/init.d/basecamp-router
CONFIG=/etc/config/basecamp
SECRET_DIR=/etc/basecamp
SECRET=$SECRET_DIR/secret
KEEP_LIST=/etc/sysupgrade.conf
BOOT_LINK=/etc/rc.d/S99basecamp-router
KEEP_FILES="/etc/basecamp/ $CONFIG $BIN $INIT $BOOT_LINK"
HEX64='^[0-9a-f]{64}$'
# The hostname prompt reads and writes the terminal, never stdin (stdin is
# this script under `curl ... | sh`). BASECAMP_TTY is a test-only override:
# the tests point it at a file holding the answers.
TTY=${BASECAMP_TTY:-/dev/tty}
# Seconds to wait for each answer, so an unattended run with a forced pty
# (ssh -tt, Ansible raw) never hangs. BASECAMP_TTY_TIMEOUT is a test-only
# override.
TTY_TIMEOUT=${BASECAMP_TTY_TIMEOUT:-60}
CR=$(printf '\r')

say() { echo "basecamp: $*"; }
die() { echo "basecamp: error: $*" >&2; exit 1; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --api|--interval|--hostname|--ref|--source)
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --api) API=$2 ;;
          --interval) INTERVAL=$2 ;;
          --hostname) HOSTNAME_ARG=$2; [ -n "$2" ] || die "--hostname needs a value" ;;
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

# Why NAME isn't a valid hostname (one RFC 1123 label), or nothing if it is.
hostname_problem() {
  case "$1" in
    '') echo "the hostname can't be empty" ;;
    *[!A-Za-z0-9-]*) echo "use only letters, digits and hyphens" ;;
    -*|*-) echo "the hostname can't start or end with a hyphen" ;;
    *) [ ${#1} -le 63 ] || echo "the hostname can be at most 63 characters" ;;
  esac
}

current_hostname() {
  uci -q get system.@system[0].hostname || cat /proc/sys/kernel/hostname 2>/dev/null
}

tty_usable() {
  # read-write, so opening a FIFO (tests) never blocks
  [ -r "$TTY" ] && [ -w "$TTY" ] && ( : <>"$TTY" ) 2>/dev/null
}

# Decide NEW_HOSTNAME: from --hostname, else by asking on the terminal (Enter
# keeps the current name; three invalid answers keep it too), else keep it.
choose_hostname() {
  current=$(current_hostname)
  if [ -n "$HOSTNAME_ARG" ]; then
    NEW_HOSTNAME=$HOSTNAME_ARG
    return 0
  fi
  if ! tty_usable; then
    say "no terminal; kept the hostname $current (use --hostname to set one)"
    return 0
  fi
  exec 3<>"$TTY"
  tries=0
  while [ $tries -lt 3 ]; do
    tries=$((tries + 1))
    printf 'basecamp: router hostname [%s]: ' "$current" >>"$TTY"
    answer=""
    # a timeout (or end of input) counts as Enter
    if ! IFS= read -r -t "$TTY_TIMEOUT" answer <&3; then
      echo >>"$TTY"
      exec 3<&-
      say "no answer; kept the hostname $current"
      return 0
    fi
    answer=${answer%"$CR"}
    [ -n "$answer" ] || break
    problem=$(hostname_problem "$answer")
    if [ -z "$problem" ]; then
      NEW_HOSTNAME=$answer
      break
    fi
    echo "basecamp: $problem" >>"$TTY"
  done
  exec 3<&-
  [ -n "$NEW_HOSTNAME" ] || say "kept the hostname $current"
}

apply_hostname() {
  [ -n "$NEW_HOSTNAME" ] || return 0
  [ "$NEW_HOSTNAME" != "$(current_hostname)" ] || { say "hostname is already $NEW_HOSTNAME"; return 0; }
  uci -q get system.@system[0] >/dev/null || uci add system system >/dev/null
  uci set system.@system[0].hostname="$NEW_HOSTNAME" && uci commit system \
    || { say "warning: couldn't save the hostname $NEW_HOSTNAME"; return 0; }
  # the live name; the reload below sets it too, but don't depend on procd
  { echo "$NEW_HOSTNAME" > /proc/sys/kernel/hostname; } 2>/dev/null
  /etc/init.d/system reload </dev/null >/dev/null 2>&1 || true
  say "hostname set to $NEW_HOSTNAME"
}

write_config() {
  [ -f "$CONFIG" ] || : > "$CONFIG"
  uci -q get basecamp.agent >/dev/null || uci set basecamp.agent=agent
  uci set basecamp.agent.api_url="$API"
  if [ -n "$INTERVAL" ]; then
    uci set basecamp.agent.interval="$INTERVAL"
  elif [ -z "$(uci -q get basecamp.agent.interval)" ]; then
    uci set basecamp.agent.interval=65
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
    damaged=0; [ -e "$SECRET" ] && damaged=1
    # BusyBox hexdump on stock firmware; sha256sum of 64 random bytes if a
    # build leaves hexdump out (OpenWrt's BusyBox has no od)
    hexdump -v -n 32 -e '/1 "%02x"' /dev/urandom > "$SECRET.new" 2>/dev/null
    grep -qE "$HEX64" "$SECRET.new" 2>/dev/null \
      || head -c 64 /dev/urandom | sha256sum | cut -c1-64 > "$SECRET.new"
    grep -qE "$HEX64" "$SECRET.new" || { rm -f "$SECRET.new"; die "couldn't generate a secret"; }
    chmod 600 "$SECRET.new" && mv "$SECRET.new" "$SECRET" || die "couldn't save $SECRET"
    if [ "$damaged" = 1 ]; then
      say "the existing secret was damaged; generated a new one — this router will need approving again"
    else
      say "generated this router's secret ($SECRET)"
    fi
  fi
  chmod 600 "$SECRET"
  umask "$old_umask"
}

add_keep_lines() {
  touch "$KEEP_LIST"
  # LuCI can save the file without a final newline: don't glue our first
  # line onto the user's last one
  if [ -s "$KEEP_LIST" ] && [ -n "$(tail -c 1 "$KEEP_LIST")" ]; then
    echo >> "$KEEP_LIST"
  fi
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
  if [ -n "$HOSTNAME_ARG" ]; then
    problem=$(hostname_problem "$HOSTNAME_ARG")
    [ -z "$problem" ] || die "--hostname $HOSTNAME_ARG: $problem"
  fi
  choose_hostname

  say "downloading the agent from $SOURCE"
  fetch "$SOURCE/basecamp-router.sh" "$BIN"
  fetch "$SOURCE/basecamp-router.init" "$INIT"
  write_config
  make_secret
  add_keep_lines

  "$INIT" stop >/dev/null 2>&1 </dev/null
  # before the first report: the portal names a new router after its hostname
  apply_hostname
  say "sending a first report to $API"
  "$BIN" once </dev/null || say "the first report didn't go through; the service keeps retrying (logread -e basecamp)"
  "$INIT" enable </dev/null || say "warning: couldn't enable the service at boot"
  "$INIT" start >/dev/null 2>&1 </dev/null || say "warning: couldn't start the service; run $INIT start"

  say "installed. This router registers with WAN MAC $("$BIN" mac 2>/dev/null </dev/null || echo unknown)."
  say "Approve it in the portal: Scanning Hardware › Routers (or from the approval notification)."
}

main() {
  say "installer starting"
  parse_args "$@"
  [ -f /etc/openwrt_release ] || die "this doesn't look like an OpenWrt / GL.iNet router"
  if command -v id >/dev/null 2>&1; then
    [ "$(id -u)" = 0 ] || die "run this as root"
  else
    [ -w /etc ] || die "run this as root"
  fi
  if [ "$UNINSTALL" = 1 ]; then uninstall; else install_agent; fi
}

main "$@"
