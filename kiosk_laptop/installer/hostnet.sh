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
#    "interfaces": [{"name": "en0", "ipv4": "10.10.48.57", "prefix": 24}]}
# Built-in tools only: `ip -j -4 addr` (Linux); `ifconfig` plus `networksetup
# -listallhardwareports` (macOS). Skips loopback, link-local, multicast,
# adapters that are down, and Docker/VPN/bridge adapters. Prints nothing; exits
# 1 (keeping the old file, which then goes stale) when it can't read or write.
#
# The data folder: KIOSK_DATA_DIR, else config.env's KIOSK_DATA_DIR, else the
# OS default. Testing hooks: KIOSK_HOSTNET_LIB=1 defines the functions without
# running main. Written for bash 3.2 (macOS's bash).
set -uo pipefail

KIOSK_DIR="${KIOSK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HOST_NETWORK_FILE='host-network.json'
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

# parse_linux: `ip -j -4 addr` on stdin -> "name<TAB>ipv4<TAB>prefix" for each
# address of an interface that is up (UP flag, operstate not DOWN). A small
# JSON tokenizer: top array > interface object > addr_info array > address.
parse_linux() {
  awk '
    { s = s $0 "\n" }
    function flush_iface(   i) {
      if (name != "" && up && oper != "DOWN")
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

# hardware_devices: `networksetup -listallhardwareports` on stdin -> the
# real adapters' device names, one per line.
hardware_devices() { awk '/^Device: / { print $2 }'; }

# parse_macos "DEVICES": `ifconfig` on stdin -> "name<TAB>ipv4<TAB>prefix" for
# each IPv4 address of an interface that is UP and not "status: inactive",
# and (when DEVICES isn't empty) one of DEVICES. Netmasks are hex or dotted.
parse_macos() {
  awk -v devs=" $(printf '%s' "${1:-}" | tr '\n' ' ') " '
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
      if (dev != "" && up && active && (devs ~ /^ *$/ || index(devs, " " dev " ")))
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

# to_json STAMP: "name<TAB>ipv4<TAB>prefix" lines on stdin -> the file's JSON.
to_json() {
  awk -F '\t' -v stamp="$1" '
    function esc(v) { gsub(/\\/, "\\\\", v); gsub(/"/, "\\\"", v); return v }
    { items = items (NR > 1 ? ", " : "") sprintf("{\"name\": \"%s\", \"ipv4\": \"%s\", \"prefix\": %d}", esc($1), $2, $3) }
    END { printf "{\"updated_at\": \"%s\", \"interfaces\": [%s]}\n", stamp, items }
  '
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

# collect: this OS's tool output, parsed (fails when the tool does).
collect() {
  local raw devices
  if [ "$OS" = Darwin ]; then
    raw=$(ifconfig 2>/dev/null) || return 1
    devices=$(networksetup -listallhardwareports 2>/dev/null | hardware_devices)
    printf '%s\n' "$raw" | parse_macos "$devices"
  else
    raw=$(ip -j -4 addr 2>/dev/null) || return 1
    printf '%s\n' "$raw" | parse_linux
  fi
}

main() {
  local found
  found=$(collect) || return 1
  write_host_network "$(data_dir)" "$(printf '%s' "$found" | usable_only | to_json "$(utc_now)")"
}

# Called on the last line so a partially written script runs nothing.
if [ "${KIOSK_HOSTNET_LIB:-0}" != "1" ]; then
  main "$@" >/dev/null 2>&1
fi
