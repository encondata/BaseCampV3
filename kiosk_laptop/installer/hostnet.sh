#!/usr/bin/env bash
# ServerSherpa kiosk host-network helper (laptop edition), macOS and Linux.
#
# Installed by install.sh next to update.sh and run at sign-in/boot and every
# 60 seconds:
#   Linux: serversherpa-kiosk-hostnet.timer, as root (the data folder's owner).
#   macOS: launch agent com.serversherpa.kiosk.hostnet, as the Docker Desktop
#          user (the data folder's owner on macOS).
#
# Writes <data folder>/host-network.json, the laptop's LAN addresses, for the
# edge (edge/hostnet.py), atomically:
#   {"updated_at": "2026-10-01T18:00:00Z",
#    "interfaces": [{"name": "en0", "ipv4": "10.10.48.57", "prefix": 24}],
#    "gateway": "10.10.48.1",
#    "self_addresses": ["10.10.48.57", "172.17.0.1"]}
# Built-in tools only: `ip -j -4 addr` plus /sys/class/net/<name>/device for
# the real adapters (Linux); `ifconfig` plus `networksetup
# -listallhardwareports` (macOS). Skips loopback, link-local, multicast,
# adapters that are down, and Docker/VPN/bridge adapters. "gateway" is the
# default route's next hop (`route -n get default` / `ip -j -4 route show
# default`), omitted when there is none or it isn't a usable IPv4 address.
# "self_addresses" is every IPv4 address the laptop owns, from the same tool
# output with nothing skipped but loopback and malformed ones: Docker/VPN/
# bridge adapters (docker0, br-*, veth*, bridge100) and adapters that are
# down included. The edge's printer guard refuses all of them, so a printer
# address can never lead back to the laptop.
# Prints nothing; exits 1 (keeping the old file, which then goes stale) when it
# can't read or write.
#
# The data folder: KIOSK_DATA_DIR, else config.env's KIOSK_DATA_DIR, else the
# OS default. Testing hooks: KIOSK_HOSTNET_LIB=1 defines the functions without
# running main; KIOSK_SYSFS_NET replaces /sys/class/net (and see the label
# printer block for its own).
#
# On Linux as root it also keeps the USB label printers working for Chrome's
# WebUSB (label_upkeep, after the file is written, best-effort and silent). Written for bash 3.2
# (macOS's bash).
set -uo pipefail

KIOSK_DIR="${KIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HOST_NETWORK_FILE='host-network.json'
SYSFS_NET="${KIOSK_SYSFS_NET:-/sys/class/net}"
OS=$(uname -s)
# launchd and systemd start jobs with a bare PATH.
PATH="$PATH:/usr/sbin:/sbin:/usr/bin:/bin"
export PATH

# data_dir: where host-network.json goes.
data_dir() {
  local line=''
  if [ -n "${KIOSK_DATA_DIR:-}" ]; then printf '%s' "$KIOSK_DATA_DIR"; return 0; fi
  if [ -f "$KIOSK_DIR/config.env" ]; then
    line=$(grep -E '^KIOSK_DATA_DIR=' "$KIOSK_DIR/config.env" | head -n 1 || true)
    line="${line#*=}"
  fi
  if [ -n "$line" ]; then printf '%s' "$line"; return 0; fi
  if [ "$OS" = Darwin ]; then printf '/Users/Shared/ServerSherpaKiosk/data'; else printf '/var/lib/serversherpa-kiosk'; fi
}

utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# parse_linux [all]: `ip -j -4 addr` on stdin -> "name<TAB>ipv4<TAB>prefix" for
# each address of an interface that is up (UP flag, operstate not DOWN), or
# of every interface with "all". A small JSON tokenizer: top array >
# interface object > addr_info array > address.
parse_linux() {
  awk -v all="$([ "${1:-}" = all ] && echo 1 || echo 0)" '
    { s = s $0 "\n" }
    function flush_iface(   i) {
      if (name != "" && (all || (up && oper != "DOWN")))
        for (i = 1; i <= n; i++) printf "%s\t%s\n", name, addrs[i]
    }
    END {
      stack = ""; key = ""; want_key = 0
      while (s != "") {
        if (match(s, /^[ \t\r\n]+/)) { s = substr(s, RLENGTH + 1); continue }
        if (match(s, /^"([^"\\]|\\.)*"/)) { tok = substr(s, 2, RLENGTH - 2); str = 1 }
        else if (match(s, /^[{}:,]/) || match(s, /^\[/) || match(s, /^\]/)) { tok = substr(s, 1, 1); str = 0 }
        else if (match(s, /^[^{}:,"\[\] \t\r\n]+/)) { tok = substr(s, 1, RLENGTH); str = 2 }
        else exit 1
        s = substr(s, RLENGTH + 1)
        top = substr(stack, length(stack), 1)
        if (str == 0 && tok == "{") {
          stack = stack "o"; want_key = 1
          if (stack == "ao") { name = ""; oper = ""; up = 0; n = 0 }
          if (stack == "aoao") { fam = ""; loc = ""; plen = "" }
        } else if (str == 0 && tok == "[") {
          if (stack == "ao") arrkey = key
          stack = stack "a"
        } else if (str == 0 && tok == "}") {
          if (stack == "aoao" && arrkey == "addr_info" && loc != "" && (fam == "" || fam == "inet"))
            addrs[++n] = loc "\t" plen
          if (stack == "ao") flush_iface()
          stack = substr(stack, 1, length(stack) - 1)
        } else if (str == 0 && tok == "]") {
          stack = substr(stack, 1, length(stack) - 1)
        } else if (str == 0 && tok == ",") {
          if (top == "o") want_key = 1
        } else if (str == 0 && tok == ":") {
          want_key = 0
        } else if (top == "o" && want_key) {
          key = tok
        } else if (stack == "ao") {
          if (key == "ifname") name = tok
          else if (key == "operstate") oper = tok
        } else if (stack == "aoa" && arrkey == "flags") {
          if (str == 1 && tok == "UP") up = 1
        } else if (stack == "aoao" && arrkey == "addr_info") {
          if (key == "family") fam = tok
          else if (key == "local") loc = tok
          else if (key == "prefixlen") plen = tok
        }
      }
    }
  '
}

# physical_only: "name<TAB>..." lines on stdin whose interface is backed by a
# device (SYSFS_NET/<name>/device exists), which drops virtual ones the name
# rules miss: virbr0, vmnet*, vboxnet*, lxcbr0, cni0, podman*, tailscale0, zt*.
physical_only() {
  local name rest
  while IFS="$(printf '\t')" read -r name rest; do
    case "$name" in ''|.|..|*/*) continue ;; esac
    [ -e "$SYSFS_NET/$name/device" ] || continue
    printf '%s\t%s\n' "$name" "$rest"
  done
}

# hardware_devices: `networksetup -listallhardwareports` on stdin -> the
# real adapters' device names, one per line.
hardware_devices() { awk '/^Device: / { print $2 }'; }

# parse_macos "DEVICES" [all]: `ifconfig` on stdin -> "name<TAB>ipv4<TAB>prefix"
# for each IPv4 address of an interface that is UP and not "status:
# inactive" (any interface with "all"), and (when DEVICES isn't empty) one of
# DEVICES. Netmasks are hex or dotted.
parse_macos() {
  awk -v devs=" $(printf '%s' "${1:-}" | tr '\n' ' ') " -v all="$([ "${2:-}" = all ] && echo 1 || echo 0)" '
    function bits(v,   b) { b = 0; while (v > 0) { b += v % 2; v = int(v / 2) } return b }
    function prefix(m,   i, p, o, k) {
      p = 0
      if (m ~ /^0x[0-9a-fA-F]+$/) {
        for (i = 3; i <= length(m); i++) p += bits(index("0123456789abcdef", tolower(substr(m, i, 1))) - 1)
      } else if (split(m, o, ".") == 4) {
        for (k = 1; k <= 4; k++) p += bits(o[k] + 0)
      } else p = -1
      return p
    }
    function flush(   i) {
      if (dev != "" && (all || (up && active)) && (devs ~ /^ *$/ || index(devs, " " dev " ")))
        for (i = 1; i <= n; i++) printf "%s\t%s\n", dev, ips[i]
    }
    /^[^ \t]/ {
      flush()
      dev = $1; sub(/:$/, "", dev)
      up = ($0 ~ /flags=[0-9a-fA-F]*<([^>]*,)?UP[,>]/); active = 1; n = 0
      next
    }
    $1 == "inet" {
      mask = ""
      for (i = 3; i < NF; i++) if ($i == "netmask") mask = $(i + 1)
      ips[++n] = $2 "\t" prefix(mask)
    }
    $1 == "status:" { active = ($2 == "active") }
    END { flush() }
  '
}

# usable_only: drops Docker/WSL/Hyper-V/VPN/bridge adapters, and addresses the
# edge won't use (as edge/hostnet.py): malformed, unspecified, loopback,
# link-local, multicast, broadcast, or a prefix outside 0-32.
usable_only() {
  awk -F '\t' '
    {
      if (tolower($1) ~ /^(docker|br-|veth|vethernet|utun|tun|tap|wg|bridge)/) next
      if (split($2, o, ".") != 4) next
      for (i = 1; i <= 4; i++) if (o[i] !~ /^[0-9]+$/ || o[i] + 0 > 255) next
      if ($3 !~ /^[0-9]+$/ || $3 + 0 > 32) next
      a = o[1] + 0; b = o[2] + 0
      if ($2 == "0.0.0.0" || $2 == "255.255.255.255" || a == 127 || (a == 169 && b == 254) || (a >= 224 && a <= 239)) next
      print
    }
  '
}

# self_only: "name<TAB>ipv4<TAB>..." lines on stdin -> each well-formed IPv4
# address once, one per line, leaving out unspecified, broadcast and loopback.
self_only() {
  awk -F '\t' '
    {
      if (split($2, o, ".") != 4) next
      for (i = 1; i <= 4; i++) if (o[i] !~ /^[0-9]+$/ || o[i] + 0 > 255) next
      if ($2 == "0.0.0.0" || $2 == "255.255.255.255" || o[1] + 0 == 127) next
      if (!seen[$2]++) print $2
    }
  '
}

# to_json STAMP [GATEWAY [SELF]]: "name<TAB>ipv4<TAB>prefix" lines on stdin ->
# the file's JSON, with a "gateway" key after the interfaces when GATEWAY
# isn't empty, then "self_addresses" (SELF split on spaces) when SELF is given.
to_json() {
  awk -F '\t' -v stamp="$1" -v gw="${2:-}" -v hasself="$([ $# -ge 3 ] && echo 1 || echo 0)" -v selfs="${3:-}" '
    function esc(v) { gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); return v }
    { items = items (NR > 1 ? ", " : "") sprintf("{\"name\": \"%s\", \"ipv4\": \"%s\", \"prefix\": %d}", esc($1), $2, $3) }
    END {
      extra = (gw != "") ? sprintf(", \"gateway\": \"%s\"", esc(gw)) : ""
      if (hasself) {
        n = split(selfs, ips, " "); list = ""
        for (i = 1; i <= n; i++) list = list (list != "" ? ", " : "") sprintf("\"%s\"", esc(ips[i]))
        extra = extra sprintf(", \"self_addresses\": [%s]", list)
      }
      printf "{\"updated_at\": \"%s\", \"interfaces\": [%s]%s}\n", stamp, items, extra
    }
  '
}

# The gateway parsers read their input to the end instead of exiting at the
# match: an early exit closes the pipe while the writer may still be writing
# (uutils tr, Ubuntu 26.04's tr, writes the unterminated tail separately), its
# SIGPIPE fails the pipeline under pipefail, and gateway() drops the result.

# parse_gateway_macos: `route -n get default` on stdin -> the gateway address.
parse_gateway_macos() { awk '!found && $1 == "gateway:" { found = 1; gw = $2 } END { if (found) print gw }'; }

# parse_gateway_linux: `ip -j -4 route show default` on stdin -> the first gateway.
parse_gateway_linux() {
  tr ',' '\n' | awk -F '"' '!found && $2 == "gateway" { found = 1; gw = $4 } END { if (found) print gw }'
}

# usable_gateway IP: IP when it is a dotted-quad unicast IPv4 address that is
# not unspecified, loopback, link-local, multicast or broadcast (as the edge).
usable_gateway() {
  printf '%s\n' "${1:-}" | awk -F . '
    NF != 4 { exit 1 }
    { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i + 0 > 255) exit 1 }
    $1 + 0 == 0 || $1 + 0 == 127 || $1 + 0 >= 224 || ($1 + 0 == 169 && $2 + 0 == 254) { exit 1 }
    { print; exit 0 }'
}

# gateway: this OS's default gateway, or nothing (a failing tool is ignored).
gateway() {
  local raw=''
  if [ "$OS" = Darwin ]; then
    raw=$(route -n get default 2>/dev/null | parse_gateway_macos) || raw=''
  else
    raw=$(ip -j -4 route show default 2>/dev/null | parse_gateway_linux) || raw=''
  fi
  if [ -n "$raw" ]; then usable_gateway "$raw" || true; fi
  return 0
}

# write_host_network DIR JSON: a temp file in DIR (mode 644) renamed over
# host-network.json, so the edge never reads half a file and a symbolic link
# there is replaced, not followed. Returns 1, quietly, when it can't.
write_host_network() {
  local dir="$1" tmp
  [ -d "$dir" ] || return 1
  tmp=$(mktemp "$dir/.$HOST_NETWORK_FILE.XXXXXX" 2>/dev/null) || return 1
  if printf '%s\n' "$2" >"$tmp" 2>/dev/null && chmod 644 "$tmp" 2>/dev/null \
     && mv -f "$tmp" "$dir/$HOST_NETWORK_FILE" 2>/dev/null; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# read_tool: this OS's address listing, raw (fails when the tool does).
read_tool() {
  if [ "$OS" = Darwin ]; then ifconfig 2>/dev/null; else ip -j -4 addr 2>/dev/null; fi
}

# lan_list: read_tool's output on stdin, parsed down to the real adapters
# that are up (usable_only then drops the rest).
lan_list() {
  local devices
  if [ "$OS" = Darwin ]; then
    devices=$(networksetup -listallhardwareports 2>/dev/null | hardware_devices)
    parse_macos "$devices"
  else
    parse_linux | physical_only
  fi
}

# self_list: read_tool's output on stdin -> every address the laptop owns,
# space-separated.
self_list() {
  if [ "$OS" = Darwin ]; then parse_macos "" all; else parse_linux all; fi | self_only | tr '\n' ' '
}

main() {
  local raw found self
  raw=$(read_tool) || return 1
  found=$(printf '%s\n' "$raw" | lan_list)
  self=$(printf '%s\n' "$raw" | self_list)
  write_host_network "$(data_dir)" "$(printf '%s' "$found" | usable_only | to_json "$(utc_now)" "$(gateway)" "$self")"
}

# The label-printer block is silent here.
lp_say() { :; }
lp_warn() { :; }

# >>> USB label printers (Linux). This block is the same in install.sh and
# hostnet.sh; tests/test_install_sh.py checks the two copies match. Every
# step is best-effort, returns 0, and acts only when something is off: it
# reports each change through lp_say and each failure through lp_warn, which
# each script defines (install.sh: info/warn; hostnet.sh: silent).
# Testing hooks: KIOSK_UDEV_RULES_DIR, KIOSK_MODPROBE_DIR, KIOSK_DOCKERD_BIN,
# KIOSK_RUN_DIR replace /etc/udev/rules.d, /etc/modprobe.d, /usr/bin/dockerd, /run.
LP_UDEV_RULES="${KIOSK_UDEV_RULES_DIR:-/etc/udev/rules.d}/60-serversherpa-label-printers.rules"
LP_MODPROBE_CONF="${KIOSK_MODPROBE_DIR:-/etc/modprobe.d}/serversherpa-no-usblp.conf"
LP_DOCKERD_BIN="${KIOSK_DOCKERD_BIN:-/usr/bin/dockerd}"
# Present while a snap Docker removal waits for Docker Engine's restart.
LP_SNAP_MARKER="${KIOSK_RUN_DIR:-/run}/serversherpa-kiosk-snap-docker-removed"

# lp_udev_rule: Zebra (USB vendor 0a5f) printers open to Chrome's WebUSB, for
# whoever is signed in at the screen (uaccess) only, never world-writable.
lp_udev_rule() {
  printf '%s\n' '# ServerSherpa kiosk: Chrome prints to USB Zebra label printers over WebUSB.' \
    'SUBSYSTEM=="usb", ATTR{idVendor}=="0a5f", TAG+="uaccess"'
}

# lp_modprobe_conf: keeps the usblp printer driver off the label printers
# (it claims them, and WebUSB then gets "Access denied").
lp_modprobe_conf() {
  printf '%s\n' '# ServerSherpa kiosk: usblp claims USB label printers, which blocks WebUSB.' \
    'blacklist usblp'
}

# lp_write FILE CONTENT: 0 when FILE was written, 1 when it already held
# CONTENT, 2 when it couldn't be written. Mode 644.
lp_write() {
  local file="$1" want="$2"
  if [ -f "$file" ] && [ "$(cat "$file" 2>/dev/null)" = "$want" ]; then return 1; fi
  if mkdir -p "$(dirname "$file")" 2>/dev/null && printf '%s\n' "$want" >"$file" 2>/dev/null \
     && chmod 644 "$file" 2>/dev/null; then
    return 0
  fi
  return 2
}

lp_ensure_udev_rule() {
  local rc=0
  lp_write "$LP_UDEV_RULES" "$(lp_udev_rule)" || rc=$?
  case "$rc" in
    0)
      lp_say "Wrote $LP_UDEV_RULES so Chrome can open USB Zebra label printers."
      if command -v udevadm >/dev/null 2>&1; then
        udevadm control --reload >/dev/null 2>&1 || true
        udevadm trigger --subsystem-match=usb --attr-match=idVendor=0a5f >/dev/null 2>&1 || true
      fi ;;
    2) lp_warn "Couldn't write $LP_UDEV_RULES; Chrome may not be able to open USB label printers." ;;
  esac
  return 0
}

lp_usblp_loaded() {
  command -v lsmod >/dev/null 2>&1 || return 1
  lsmod 2>/dev/null | awk '$1 == "usblp" { found = 1 } END { exit !found }'
}

lp_ensure_no_usblp() {
  local rc=0
  lp_write "$LP_MODPROBE_CONF" "$(lp_modprobe_conf)" || rc=$?
  case "$rc" in
    0) lp_say "Wrote $LP_MODPROBE_CONF (the usblp driver no longer claims label printers)." ;;
    2) lp_warn "Couldn't write $LP_MODPROBE_CONF." ;;
  esac
  if lp_usblp_loaded && command -v modprobe >/dev/null 2>&1; then
    if modprobe -r usblp >/dev/null 2>&1; then
      lp_say "Unloaded the usblp driver."
    else
      lp_warn "Couldn't unload the usblp driver (it is blocked from the next start on)."
    fi
  fi
  return 0
}

# lp_zebra_queues: `lpstat -v` on stdin -> the names of the CUPS queues whose
# device URI starts with usb://Zebra, one per line.
lp_zebra_queues() {
  awk '$1 == "device" && $2 == "for" && index($4, "usb://Zebra") == 1 { q = $3; sub(/:$/, "", q); print q }'
}

# lp_remove_zebra_queues: the USB Zebra queues Ubuntu sets up on its own; CUPS
# holding the printer blocks WebUSB. Other printers are never touched.
lp_remove_zebra_queues() {
  local q
  command -v lpstat >/dev/null 2>&1 && command -v lpadmin >/dev/null 2>&1 || return 0
  for q in $(LC_ALL=C lpstat -v 2>/dev/null | lp_zebra_queues); do
    if lpadmin -x "$q" >/dev/null 2>&1; then
      lp_say "Removed the CUPS printer queue $q (the kiosk prints to USB Zebras itself)."
    else
      lp_warn "Couldn't remove the CUPS printer queue $q."
    fi
  done
  return 0
}

lp_snap_has() { command -v snap >/dev/null 2>&1 && snap list "$1" >/dev/null 2>&1; }

# lp_engine_present: Docker Engine (docker-ce or docker.io), not the snap.
lp_engine_present() {
  [ -x "$LP_DOCKERD_BIN" ] && return 0
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl cat docker.service 2>/dev/null | awk '
    /^ExecStart=/ { exec = 1 } /\/snap\// { snap = 1 } END { exit !(exec && !snap) }'
}

lp_restart_engine() {
  if systemctl restart docker.socket docker.service >/dev/null 2>&1; then
    rm -f "$LP_SNAP_MARKER" 2>/dev/null || true
    lp_say "Restarted Docker Engine."
  else
    lp_warn "Couldn't restart Docker Engine (systemctl restart docker.socket docker.service)."
  fi
}

# lp_remove_snap_docker: snap Docker next to Docker Engine fights it for
# /var/run/docker.sock and can't write the data folder ("read-only file
# system"), so the snap goes. Only when Docker Engine is there to take over.
# The marker finishes the restart on a later run if this one is cut short.
lp_remove_snap_docker() {
  if lp_snap_has docker; then
    lp_engine_present || return 0
    : >"$LP_SNAP_MARKER" 2>/dev/null || true
    if snap remove --purge docker >/dev/null 2>&1; then
      lp_say "Removed snap Docker (Docker Engine runs the kiosk)."
      lp_restart_engine
    else
      lp_warn "Couldn't remove snap Docker (snap remove --purge docker)."
    fi
  elif [ -e "$LP_SNAP_MARKER" ]; then
    lp_restart_engine
  fi
  return 0
}

# lp_chromium_raw_usb: snap Chromium reaches USB devices only through its
# raw-usb interface, which is off by default.
lp_chromium_raw_usb() {
  lp_snap_has chromium || return 0
  if snap connections chromium 2>/dev/null \
       | awk '$2 == "chromium:raw-usb" && $3 != "-" { found = 1 } END { exit !found }'; then
    return 0
  fi
  if snap connect chromium:raw-usb >/dev/null 2>&1; then
    lp_say "Let snap Chromium use USB devices (snap connect chromium:raw-usb)."
  else
    lp_warn "Couldn't let snap Chromium use USB devices (snap connect chromium:raw-usb)."
  fi
  return 0
}

# lp_upkeep: every check above, cheapest first.
lp_upkeep() {
  lp_ensure_no_usblp
  lp_remove_zebra_queues
  lp_ensure_udev_rule
  lp_chromium_raw_usb
  lp_remove_snap_docker
  return 0
}
# <<< USB label printers

# label_upkeep: on Linux as root, put the USB label-printer setup back if
# anything undid it (install.sh does the same at install time). Never on macOS.
label_upkeep() {
  [ "$OS" = Linux ] || return 0
  [ "$(id -u 2>/dev/null)" = 0 ] || return 0
  lp_upkeep
}

# Called on the last lines so a partially written script runs nothing. The
# upkeep runs after host-network.json is written, in a subshell, so nothing
# in it can change the exit code.
if [ "${KIOSK_HOSTNET_LIB:-0}" != "1" ]; then
  main "$@" >/dev/null 2>&1
  rc=$?
  ( label_upkeep ) >/dev/null 2>&1 || true
  exit "$rc"
fi
