#!/bin/sh
# BaseCamp router agent: sends this GL.iNet router's status to the
# BaseCamp API every few minutes. Send-only — the only thing it reads
# back is the HTTP status code. Nothing it sends is stored until the
# router is approved in the portal (Scanning Hardware › Routers).
#
#   basecamp-router run       report forever (the procd service runs this)
#   basecamp-router once      send one report now and print the result
#   basecamp-router dry-run   print the report (secret hidden), send nothing
#   basecamp-router mac       print the WAN MAC this router registers with
#
# Config: uci basecamp.agent.{api_url,interval,enabled}; secret in
# /etc/basecamp/secret. BASECAMP_ROOT prefixes every file path (tests).

AGENT_VERSION="1.0.0"
ROOT="${BASECAMP_ROOT:-}"
SECRET_FILE="$ROOT/etc/basecamp/secret"
MAX_DHCP=512
MAX_VPN=32
HANDSHAKE_FRESH=180
HEX='[0-9A-Fa-f][0-9A-Fa-f]'
MAC_RE="^$HEX:$HEX:$HEX:$HEX:$HEX:$HEX\$"
TMP="${TMPDIR:-/tmp}/basecamp.$$"

umask 077
. "${JSHN:-/usr/share/libubox/jshn.sh}"

log() { logger -t basecamp "$*"; }
cfg() { uci -q get "basecamp.agent.$1"; }
lower() { tr 'A-Z' 'a-z'; }
iface_status() { ubus call "network.interface.$1" status 2>/dev/null; }
jget() { jsonfilter -e "$1" 2>/dev/null | head -n 1; }  # stdin JSON

# prefix length -> dotted netmask
netmask() {
  bits=${1:-0}; mask=""; i=0
  while [ $i -lt 4 ]; do
    if [ "$bits" -ge 8 ]; then oct=255; bits=$((bits - 8))
    else oct=$((256 - (1 << (8 - bits)))); bits=0; fi
    mask="${mask:+$mask.}$oct"; i=$((i + 1))
  done
  echo "$mask"
}

str_or_null() {  # name value
  if [ -n "$2" ] && [ "$2" != "-" ]; then json_add_string "$1" "$2"; else json_add_null "$1"; fi
}

# The WAN port's own MAC — stable whichever uplink (cable, repeater,
# tethering) is active, so the router keeps one identity.
wan_mac() {
  dev=$(uci -q get network.wan.device || uci -q get network.wan.ifname)
  [ -n "$dev" ] || dev=$(iface_status wan | jget '@.device')
  set -- $dev
  [ -n "${1:-}" ] && [ -r "$ROOT/sys/class/net/$1/address" ] || return 1
  lower < "$ROOT/sys/class/net/$1/address"
}

model() {
  if [ -s "$ROOT/tmp/sysinfo/model" ]; then cat "$ROOT/tmp/sysinfo/model"
  else ubus call system board 2>/dev/null | jget '@.model'; fi
}

firmware() {
  if [ -s "$ROOT/etc/glversion" ]; then cat "$ROOT/etc/glversion"
  elif [ -r "$ROOT/etc/openwrt_release" ]; then
    (. "$ROOT/etc/openwrt_release"; echo "${DISTRIB_RELEASE:-}")
  fi
}

add_wan() {
  name=wan
  if [ "$(iface_status wan | jget '@.up')" != true ] \
     && [ "$(iface_status wwan | jget '@.up')" = true ]; then
    name=wwan
  fi
  s=$(iface_status "$name")
  if [ -z "$s" ]; then json_add_null wan; return; fi
  json_add_object wan
  json_add_string interface "$name"
  str_or_null ip "$(echo "$s" | jget '@["ipv4-address"][0].address')"
  str_or_null gateway "$(echo "$s" | jget '@.route[@.target="0.0.0.0"].nexthop')"
  str_or_null proto "$(echo "$s" | jget '@.proto')"
  if [ "$(echo "$s" | jget '@.up')" = true ]; then json_add_boolean up 1; else json_add_boolean up 0; fi
  json_close_object
}

add_lan() {
  s=$(iface_status lan)
  if [ -z "$s" ]; then json_add_null lan; return; fi
  json_add_object lan
  str_or_null ip "$(echo "$s" | jget '@["ipv4-address"][0].address')"
  bits=$(echo "$s" | jget '@["ipv4-address"][0].mask')
  if [ -n "$bits" ]; then json_add_string netmask "$(netmask "$bits")"; else json_add_null netmask; fi
  json_close_object
}

# One entry per wifi-iface (SSID). Station MACs go to $TMP.assoc for the
# wired/wireless split.
add_wifi() {
  : > "$TMP.assoc"
  status=$(ubus call network.wireless status 2>/dev/null)
  json_add_array wifi
  for s in $(uci -q show wireless | sed -n "s/^wireless\.\([^.=]*\)=wifi-iface$/\1/p"); do
    radio=$(uci -q get "wireless.$s.device")
    band=$(uci -q get "wireless.$radio.band")
    if [ -z "$band" ]; then
      case "$(uci -q get "wireless.$radio.hwmode")" in 11a|11ac|11ax_5g) band=5g ;; *) band=2g ;; esac
    fi
    enabled=1
    [ "$(uci -q get "wireless.$radio.disabled")" = 1 ] && enabled=0
    [ "$(uci -q get "wireless.$s.disabled")" = 1 ] && enabled=0
    ifname=$(echo "$status" | jget "@.$radio.interfaces[@.section='$s'].ifname")
    [ -n "$ifname" ] || ifname=$(uci -q get "wireless.$s.ifname")
    channel=""; clients=0
    if [ "$enabled" = 1 ] && [ -n "$ifname" ]; then
      channel=$(iwinfo "$ifname" info 2>/dev/null | sed -n 's/.*Channel: \([0-9][0-9]*\).*/\1/p' | head -n 1)
      iwinfo "$ifname" assoclist 2>/dev/null | awk -v re="$MAC_RE" '$1 ~ re { print tolower($1) }' > "$TMP.one"
      clients=$(wc -l < "$TMP.one" | tr -d ' ')
      cat "$TMP.one" >> "$TMP.assoc"
    fi
    if [ -z "$channel" ]; then
      channel=$(uci -q get "wireless.$radio.channel")
      case "$channel" in ''|*[!0-9]*) channel="" ;; esac
    fi
    json_add_object ""
    json_add_string radio "$radio"
    json_add_string band "$band"
    json_add_string ssid "$(uci -q get "wireless.$s.ssid")"
    if [ -n "$channel" ]; then json_add_int channel "$channel"; else json_add_null channel; fi
    json_add_boolean enabled "$enabled"
    json_add_int clients "$clients"
    json_close_object
  done
  json_close_array
}

# Leases + static reservations, merged per MAC; up = in the neighbor table.
add_dhcp() {
  : > "$TMP.raw"
  if [ -r "$ROOT/tmp/dhcp.leases" ]; then
    awk '{ h = ($4 == "*" ? "-" : $4); print "L", tolower($2), $3, h }' "$ROOT/tmp/dhcp.leases" >> "$TMP.raw"
  fi
  i=0
  while uci -q get "dhcp.@host[$i]" >/dev/null; do
    hip=$(uci -q get "dhcp.@host[$i].ip"); hname=$(uci -q get "dhcp.@host[$i].name")
    for m in $(uci -q get "dhcp.@host[$i].mac"); do
      echo "R $(echo "$m" | lower) ${hip:--} ${hname:--}" >> "$TMP.raw"
    done
    i=$((i + 1))
  done
  ip neigh show 2>/dev/null | awk '/lladdr/ && /REACHABLE|STALE|DELAY|PROBE|PERMANENT/ {
    for (i = 1; i < NF; i++) if ($i == "lladdr") print tolower($(i + 1)) }' > "$TMP.neigh"
  awk -v neigh="$TMP.neigh" '
    BEGIN { while ((getline m < neigh) > 0) up[m] = 1 }
    { mac = $2
      if (!(mac in seen)) { seen[mac] = 1; order[++n] = mac; ip[mac] = "-"; host[mac] = "-" }
      if ($1 == "R") { res[mac] = 1; if (ip[mac] == "-") ip[mac] = $3; if (host[mac] == "-") host[mac] = $4 }
      else { ip[mac] = $3; if ($4 != "-") host[mac] = $4 } }
    END { for (i = 1; i <= n; i++) { m = order[i]
            print m, ip[m], host[m], ((m in res) ? 1 : 0), ((m in up) ? 1 : 0) } }
  ' "$TMP.raw" | head -n "$MAX_DHCP" > "$TMP.dhcp"

  wired=0
  json_add_array dhcp_clients
  while read -r mac cip chost reserved isup; do
    json_add_object ""
    json_add_string mac "$mac"
    str_or_null ip "$cip"
    str_or_null hostname "$chost"
    json_add_boolean reserved "$reserved"
    json_add_boolean up "$isup"
    json_close_object
    if [ "$isup" = 1 ] && ! grep -qx "$mac" "$TMP.assoc"; then wired=$((wired + 1)); fi
  done < "$TMP.dhcp"
  json_close_array

  wireless=$(sort -u "$TMP.assoc" | grep -c .)
  json_add_object clients
  json_add_int total $((wired + wireless))
  json_add_int wired "$wired"
  json_add_int wireless "$wireless"
  json_close_object
}

add_tunnel() {  # name type role enabled up endpoint handshake_age
  [ "$VPN_COUNT" -lt "$MAX_VPN" ] || return 0
  json_add_object ""
  json_add_string name "$1"
  json_add_string type "$2"
  json_add_string role "$3"
  json_add_boolean enabled "$4"
  json_add_boolean up "$5"
  str_or_null endpoint "$6"
  if [ -n "$7" ]; then json_add_int last_handshake_seconds "$7"; else json_add_null last_handshake_seconds; fi
  json_close_object
  VPN_COUNT=$((VPN_COUNT + 1))
}

add_vpn() {
  VPN_COUNT=0
  now=$(date +%s)
  json_add_array vpn
  # WireGuard / OpenVPN as network interfaces: stock OpenWrt 'wireguard',
  # GL.iNet 4.x 'wgclient'/'wgserver'/'ovpnclient'/'ovpnserver'.
  uci -q show network | sed -nE \
    "s/^network\.([^.=]+)\.proto='?(wireguard|wgclient|wgserver|ovpnclient|ovpnserver)'?$/\1 \2/p" > "$TMP.vpnifs"
  while read -r s proto; do
    enabled=1; [ "$(uci -q get "network.$s.disabled")" = 1 ] && enabled=0
    case "$proto" in *server) role=server ;; *) role=client ;; esac
    case "$proto" in w*) type=wireguard ;; *) type=openvpn ;; esac
    ifup=$(iface_status "$s" | jget '@.up')
    up=0; endpoint=""; age=""
    if [ "$type" = wireguard ]; then
      latest=$(wg show "$s" latest-handshakes 2>/dev/null | awk 'BEGIN { m = 0 } $2 > m { m = $2 } END { print m }')
      if [ "${latest:-0}" -gt 0 ]; then
        age=$((now - latest))
        [ "$age" -le "$HANDSHAKE_FRESH" ] && up=1
      fi
      if [ "$role" = server ]; then
        # a server with no peer connected right now is still up
        [ "$ifup" = true ] && up=1
      else
        endpoint=$(wg show "$s" endpoints 2>/dev/null | awk '$2 != "(none)" { print $2; exit }')
      fi
    else
      [ "$ifup" = true ] && up=1
    fi
    [ "$enabled" = 1 ] || up=0
    add_tunnel "$s" "$type" "$role" "$enabled" "$up" "$endpoint" "$age"
  done < "$TMP.vpnifs"

  # Stock OpenVPN instances (/etc/config/openvpn). The package ships
  # disabled samples, so only enabled instances are reported.
  for s in $(uci -q show openvpn | sed -nE "s/^openvpn\.([^.=]+)=openvpn$/\1/p"); do
    [ "$(uci -q get "openvpn.$s.enabled")" = 1 ] || continue
    role=client
    if [ -n "$(uci -q get "openvpn.$s.server")" ] || [ "$(uci -q get "openvpn.$s.mode")" = server ]; then
      role=server
    fi
    up=0; pidf="$ROOT/var/run/openvpn.$s.pid"
    if [ -r "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then up=1; fi
    endpoint=""
    # `uci get` quotes list items holding a space ('host 1194' 'b 443');
    # older uci and `option remote` print them bare. First remote wins.
    [ "$role" = client ] && endpoint=$(uci -q get "openvpn.$s.remote" | tr -d "'" | awk '{ print $1 ($2 ? ":" $2 : ""); exit }')
    add_tunnel "$s" openvpn "$role" 1 "$up" "$endpoint" ""
  done

  if command -v tailscale >/dev/null 2>&1; then
    up=0; tailscale status >/dev/null 2>&1 && up=1
    add_tunnel tailscale tailscale client 1 "$up" "" ""
  fi
  if command -v zerotier-cli >/dev/null 2>&1; then
    up=0; zerotier-cli info 2>/dev/null | grep -q ONLINE && up=1
    add_tunnel zerotier zerotier client 1 "$up" "" ""
  fi
  json_close_array
}

build_report() {
  mac=$(wan_mac) || { log "can't find the WAN MAC address"; return 1; }
  secret=$(cat "$SECRET_FILE" 2>/dev/null)
  case "$secret" in
    *[!0-9a-f]*|'') log "missing or damaged secret in $SECRET_FILE — reinstall the agent"; return 1 ;;
  esac
  [ ${#secret} -eq 64 ] || { log "damaged secret in $SECRET_FILE — reinstall the agent"; return 1; }
  json_init
  json_add_int schema_version 1
  json_add_string agent_version "$AGENT_VERSION"
  json_add_string wan_mac "$mac"
  json_add_string secret "$secret"
  str_or_null model "$(model)"
  str_or_null firmware "$(firmware)"
  str_or_null hostname "$(uci -q get system.@system[0].hostname || cat "$ROOT/proc/sys/kernel/hostname" 2>/dev/null)"
  json_add_int uptime_seconds "$(cut -d. -f1 "$ROOT/proc/uptime")"
  add_wan
  add_lan
  add_wifi
  add_dhcp
  add_vpn
  json_dump
}

send_report() {  # prints the HTTP status ("000" = no answer)
  api=$(cfg api_url)
  if [ -z "$api" ]; then log "api_url is not set (uci basecamp.agent.api_url)"; echo 000; return; fi
  build_report > "$TMP.json" || { echo 000; return; }
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H 'Content-Type: application/json' --data-binary "@$TMP.json" \
    "${api%/}/router-agent/report" 2>>"$TMP.err") || true
  rm -f "$TMP.json"
  [ -s "$TMP.err" ] && log "$(tail -n 1 "$TMP.err")"
  : > "$TMP.err"
  echo "${code:-000}"
}

describe() {
  case "$1" in
    200) echo "approved — reporting" ;;
    202) echo "registered — waiting for approval in the portal (Scanning Hardware › Routers)" ;;
    429) echo "rate limited — will retry" ;;
    000) echo "could not reach the API" ;;
    *) echo "the API answered HTTP $1" ;;
  esac
}

jitter() { awk -v max="$1" 'BEGIN { srand(); print int(rand() * (max + 1)) }'; }

run_loop() {
  # let the WAN come up after a boot, and stay clear of the installer's report
  sleep $((30 + $(jitter 30)))
  while :; do
    interval=$(cfg interval)
    case "$interval" in ''|*[!0-9]*) interval=300 ;; esac
    [ "$interval" -ge 60 ] || interval=60
    code=$(send_report)
    case "$code" in 200|202) ;; *) log "report not accepted: $(describe "$code")" ;; esac
    extra=0; [ "$code" = 429 ] && extra=$interval
    sleep $((interval + extra + $(jitter 30)))
  done
}

trap 'rm -f "$TMP".*' EXIT
trap 'exit 0' INT TERM

case "${1:-}" in
  run) run_loop ;;
  once)
    code=$(send_report)
    echo "BaseCamp: $(describe "$code")"
    [ "$code" = 200 ] || [ "$code" = 202 ]
    ;;
  dry-run)
    # a file, not a pipe, so a failed build_report fails the command
    build_report > "$TMP.dry" && sed 's/"secret": *"[0-9a-f]*"/"secret": "<hidden>"/' "$TMP.dry"
    ;;
  mac) wan_mac ;;
  *) echo "usage: basecamp-router run|once|dry-run|mac" >&2; exit 2 ;;
esac
