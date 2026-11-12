#!/usr/bin/env bash
# ServerSherpa kiosk setup for Ubuntu: a guided front end over install.sh.
#
#   wget -qO- https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/setup.sh | bash
#   bash kiosk_laptop/installer/setup.sh          # from a checkout
#
# It shows what's installed and what's missing, lets you pick the environment,
# then runs install.sh one step at a time with progress and Try again.
# Answers are read from /dev/tty, because stdin is the script when piped.
#
# Environment overrides:
#   KIOSK_DIR              install folder (default /opt/serversherpa-kiosk)
#   KIOSK_INSTALLER_REF    git ref install.sh is fetched from (default main)
#
# Testing hooks (not for normal use):
#   KIOSK_SETUP_ENGINE     use this install.sh instead of downloading one
#   KIOSK_VAR_LIB          replaces /var/lib in the data folder paths
#   KIOSK_OS_RELEASE       read this file instead of /etc/os-release
#   KIOSK_SETUP_LOG        log file (default /var/log/serversherpa-kiosk-setup.log)
#   KIOSK_TTY, KIOSK_TTY_OUT  files to read answers from and write prompts to
#   KIOSK_TEMPLATE_DIR     passed on to install.sh (companion files folder)
#   KIOSK_SETUP_LIB=1      define the functions without running main
#
# Written for bash 3.2 (macOS's bash).
# shellcheck disable=SC2034  # globals set here are read by later parts of the setup
set -u -o pipefail

# ── Hooks and globals ─────────────────────────────────────────────────
KIOSK_DIR="${KIOSK_DIR:-/opt/serversherpa-kiosk}"
VAR_LIB="${KIOSK_VAR_LIB:-/var/lib}"
PROD_DATA_DIR="$VAR_LIB/serversherpa-kiosk"
DEV_DATA_DIR="$VAR_LIB/serversherpa-kiosk-dev"
OS_RELEASE_FILE="${KIOSK_OS_RELEASE:-/etc/os-release}"
SETUP_LOG="${KIOSK_SETUP_LOG:-/var/log/serversherpa-kiosk-setup.log}"
TTY_IN="${KIOSK_TTY:-/dev/tty}"
TTY_OUT="${KIOSK_TTY_OUT:-/dev/tty}"
ENGINE="${KIOSK_SETUP_ENGINE:-}"
KIOSK_SETUP_YES="${KIOSK_SETUP_YES:-0}"   # 1 = --yes: no dialogs at all
OPT_ENV=''                                # --env ENV
MIN_FREE_KIB=10485760   # 10 GB

HAVE_CONFIG=0
SAVED_API=''
SAVED_PORTAL=''
SAVED_CHANNEL=''
SAVED_DATA_DIR=''

ENGINE_ARGS=()
ENGINE_DATA_DIR=''

# ── Environment table ─────────────────────────────────────────────────
PROD_API="https://api.serversherpa.com"
PROD_PORTAL="https://portal.serversherpa.com"
DEV_API="https://api.dev.serversherpa.com"
DEV_PORTAL="https://portal.dev.serversherpa.com"

env_api() {
  case "$1" in
    prod|rc) printf '%s' "$PROD_API" ;;
    dev|edge) printf '%s' "$DEV_API" ;;
    custom) printf '%s' "$SAVED_API" ;;
  esac
}

env_portal() {
  case "$1" in
    prod|rc) printf '%s' "$PROD_PORTAL" ;;
    dev|edge) printf '%s' "$DEV_PORTAL" ;;
    custom) printf '%s' "$SAVED_PORTAL" ;;
  esac
}

env_channel() {
  case "$1" in
    prod) printf 'stable' ;;
    rc|dev) printf 'beta' ;;
    edge) printf 'edge' ;;
    custom) printf '%s' "$SAVED_CHANNEL" ;;
  esac
}

env_label() {
  case "$1" in
    prod) printf 'Prod' ;;
    rc) printf 'RC' ;;
    dev) printf 'Dev' ;;
    edge) printf 'Edge' ;;
    custom) printf 'Custom (keep current settings)' ;;
    none) printf 'Not set up' ;;
  esac
}

# env_short_label ENV: the label for use inside a sentence ("Custom").
env_short_label() {
  if [ "$1" = custom ]; then printf 'Custom'; else env_label "$1"; fi
}

# env_desc ENV: the picker's description of ENV.
env_desc() {
  case "$1" in
    prod) printf 'Production servers, released versions (stable)' ;;
    rc) printf 'Production servers, release candidates (beta)' ;;
    dev) printf 'Dev servers, release candidates (beta)' ;;
    edge) printf 'Dev servers, every build of main (edge)' ;;
    custom) printf '%s, %s' "$SAVED_API" "$SAVED_CHANNEL" ;;
  esac
}

# trim_slashes VALUE: VALUE without trailing slashes ("/" stays "/").
trim_slashes() {
  local v="$1"
  while [ "${#v}" -gt 1 ] && [ "${v%/}" != "$v" ]; do v="${v%/}"; done
  printf '%s' "$v"
}

# url_server_set URL: prod, dev or other.
url_server_set() {
  case "$(trim_slashes "$1")" in
    "$PROD_API") printf 'prod' ;;
    "$DEV_API") printf 'dev' ;;
    *) printf 'other' ;;
  esac
}

# env_server_set ENV: prod, dev or other.
env_server_set() {
  case "$1" in
    prod|rc) printf 'prod' ;;
    dev|edge) printf 'dev' ;;
    custom) url_server_set "$SAVED_API" ;;
    *) printf 'other' ;;
  esac
}

# ── Saved configuration ───────────────────────────────────────────────
config_value() {  # config_value FILE KEY -> value of the first KEY= line
  local line
  line=$(grep "^$2=" "$1" 2>/dev/null | head -n 1)
  printf '%s' "${line#*=}"
}

# load_saved_config: read $KIOSK_DIR/config.env without sourcing it.
load_saved_config() {
  local file="$KIOSK_DIR/config.env"
  HAVE_CONFIG=0; SAVED_API=''; SAVED_PORTAL=''; SAVED_CHANNEL=''; SAVED_DATA_DIR=''
  [ -f "$file" ] || return 0
  HAVE_CONFIG=1
  SAVED_API=$(config_value "$file" EDGE_CLOUD_API_URL)
  SAVED_PORTAL=$(config_value "$file" EDGE_PORTAL_URL)
  SAVED_CHANNEL=$(config_value "$file" KIOSK_CHANNEL)
  SAVED_DATA_DIR=$(config_value "$file" KIOSK_DATA_DIR)
}

# detect_env API PORTAL CHANNEL: prod, rc, dev, edge or custom.
detect_env() {
  local api portal set=''
  api=$(trim_slashes "$1"); portal=$(trim_slashes "$2")
  if [ "$api" = "$PROD_API" ] && [ "$portal" = "$PROD_PORTAL" ]; then set=prod
  elif [ "$api" = "$DEV_API" ] && [ "$portal" = "$DEV_PORTAL" ]; then set=dev
  fi
  case "$set:$3" in
    prod:stable) printf 'prod' ;;
    prod:beta) printf 'rc' ;;
    dev:beta) printf 'dev' ;;
    dev:edge) printf 'edge' ;;
    *) printf 'custom' ;;
  esac
}

current_env() {
  if [ "$HAVE_CONFIG" != 1 ]; then printf 'none'; return 0; fi
  detect_env "$SAVED_API" "$SAVED_PORTAL" "$SAVED_CHANNEL"
}

# ── Data folders ──────────────────────────────────────────────────────
# saved_custom_data_dir: the saved data folder when it is neither standard
# folder (set with install.sh flags; never moved), else nothing.
saved_custom_data_dir() {
  local d
  d=$(trim_slashes "$SAVED_DATA_DIR")
  [ -n "$d" ] || return 0
  [ "$d" = "$PROD_DATA_DIR" ] || [ "$d" = "$DEV_DATA_DIR" ] || printf '%s' "$d"
}

# data_dir_for ENV: the KIOSK_DATA_DIR to pass to install.sh for ENV.
data_dir_for() {
  local custom
  [ "$1" != custom ] || return 0
  custom=$(saved_custom_data_dir)
  if [ -n "$custom" ]; then printf '%s' "$custom"; return 0; fi
  if [ "$(env_server_set "$1")" = dev ]; then printf '%s' "$DEV_DATA_DIR"
  else printf '%s' "$PROD_DATA_DIR"
  fi
}

# server_set_note FROM TO: one line when the switch changes the server set.
server_set_note() {
  local from to
  [ "$1" != none ] || return 0
  [ -z "$(saved_custom_data_dir)" ] || return 0
  from=$(env_server_set "$1"); to=$(env_server_set "$2")
  [ "$from" != other ] && [ "$to" != other ] && [ "$from" != "$to" ] || return 0
  if [ "$to" = dev ]; then
    printf 'This laptop will use a separate dev kiosk. Its production kiosk data is kept for when you switch back.'
  else
    printf 'This laptop will use a separate production kiosk. Its dev kiosk data is kept for when you switch back.'
  fi
}

# set_engine_args ENV: the install.sh flags and data folder for ENV.
set_engine_args() {
  if [ "$1" = custom ]; then
    ENGINE_ARGS=(); ENGINE_DATA_DIR=''
    return 0
  fi
  ENGINE_ARGS=(--api-url "$(env_api "$1")" --portal-url "$(env_portal "$1")" --channel "$(env_channel "$1")")
  ENGINE_DATA_DIR=$(data_dir_for "$1")
}

# ── System helpers ────────────────────────────────────────────────────
# safe_ref REF: REF when it is a plain git ref (letters, digits, . _ / -, no
# ".."), else main. A ref goes into a download URL.
safe_ref() {
  case "$1" in
    ''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-]*|*..*)
      [ -z "$1" ] || printf "Ignoring the installer ref '%s' (letters, digits, . _ / - only); using main.\n" "$1" >&2
      printf 'main' ;;
    *) printf '%s' "$1" ;;
  esac
}

INSTALLER_REF=$(safe_ref "${KIOSK_INSTALLER_REF:-main}")
BASE_URL="https://raw.githubusercontent.com/encondata/BaseCampV3/$INSTALLER_REF/kiosk_laptop/installer"

is_root() { [ "$(id -u)" -eq 0 ]; }

# as_root CMD...: run directly when root, else through sudo without prompting.
as_root() {
  if is_root; then "$@"; else sudo -n "$@"; fi
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# tty_ok: the answer tty opens for reading and the prompt tty for writing.
# ([ -r /dev/tty ] is true even with no controlling terminal, so open them.)
tty_ok() { { : <"$TTY_IN" >>"$TTY_OUT"; } 2>/dev/null; }

# tty_say TEXT: one line on the prompt tty, or on stderr when it won't open.
tty_say() {
  { printf '%s\n' "$1" >>"$TTY_OUT"; } 2>/dev/null || printf '%s\n' "$1" >&2
}

pkg_installed() {
  dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'
}

# free_kib PATH: KiB available on PATH's file system (/ when PATH is missing).
free_kib() {
  local p="$1"
  [ -e "$p" ] || p=/
  df -Pk "$p" 2>/dev/null | awk 'NR == 2 { print $4 }'
}

# net_ok URL: 0 when URL gives any HTTP answer.
net_ok() {
  local rc
  if have_cmd curl; then
    curl -sS -o /dev/null --max-time 10 "$1" >/dev/null 2>&1
  else
    wget -q --spider --timeout=10 --tries=1 "$1" >/dev/null 2>&1; rc=$?
    [ "$rc" -eq 0 ] || [ "$rc" -eq 8 ]
  fi
}

# download URL DEST
download() {
  if have_cmd curl; then curl -fsSL --max-time 60 "$1" -o "$2"
  else wget -qO "$2" "$1"
  fi
}

os_release_value() {  # os_release_value KEY -> unquoted value
  local v
  v=$(config_value "$OS_RELEASE_FILE" "$1")
  v=${v#\"}; v=${v%\"}; v=${v#\'}; v=${v%\'}
  printf '%s' "$v"
}

# ubuntu_version_ok VERSION: 22.04 or newer.
ubuntu_version_ok() {
  local v="$1" major rest minor
  case "$v" in ''|*[!0123456789.]*) return 1 ;; esac
  case "$v" in *.*) ;; *) return 1 ;; esac
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ -n "$major" ] && [ -n "$minor" ] || return 1
  [ "$((10#$major))" -gt 22 ] && return 0
  [ "$((10#$major))" -eq 22 ] && [ "$((10#$minor))" -ge 4 ]
}

# ── Checklist rows ────────────────────────────────────────────────────
ROW_IDS=(ubuntu admin internet disk tools docker snapdocker chrome python3 printers kiosk)
ROW_LABELS=("Ubuntu version" "Administrator rights" "Internet" "Disk space" "Download tools"
            "Docker Engine" "Snap Docker" "Google Chrome" "python3" "USB label printers" "Kiosk")
ROW_STATES=(-- -- -- -- -- -- -- -- -- -- --)
ROW_NOTES=('' '' '' '' '' '' '' '' '' '' '')
ENGINE_ROWS="docker snapdocker chrome python3 printers kiosk"

row_index() {  # row_index ID -> index into the row arrays
  local i=0
  while [ "$i" -lt "${#ROW_IDS[@]}" ]; do
    if [ "${ROW_IDS[$i]}" = "$1" ]; then printf '%s' "$i"; return 0; fi
    i=$((i + 1))
  done
  return 1
}

row_set() {  # row_set ID STATE NOTE
  local i
  i=$(row_index "$1") || return 1
  ROW_STATES[i]="$2"; ROW_NOTES[i]="$3"
}

row_state() { local i; i=$(row_index "$1") || return 1; printf '%s' "${ROW_STATES[$i]}"; }
row_note() { local i; i=$(row_index "$1") || return 1; printf '%s' "${ROW_NOTES[$i]}"; }

row_marker() {
  case "$1" in
    ok) printf '[ OK ]' ;;
    add) printf '[ ADD ]' ;;
    fix) printf '[ FIX ]' ;;
    *) printf '[ -- ]' ;;
  esac
}

# ── Checks ────────────────────────────────────────────────────────────
check_ubuntu() {
  local id version
  id=$(os_release_value ID); version=$(os_release_value VERSION_ID)
  if [ "$id" = ubuntu ] && ubuntu_version_ok "$version"; then
    row_set ubuntu ok "Ubuntu $version"
  else
    row_set ubuntu fix "This setup supports Ubuntu 22.04 and newer."
  fi
}

check_admin() {
  if is_root; then row_set admin ok "running as root"; return 0; fi
  if sudo -n true >/dev/null 2>&1; then row_set admin ok "sudo"; return 0; fi
  if [ "$KIOSK_SETUP_YES" != 1 ] && tty_ok; then
    tty_say 'Administrator rights are needed; sudo may ask for your password.'
    # shellcheck disable=SC2024  # the redirects are ours: sudo reads the password from the tty
    { sudo -v <"$TTY_IN" >>"$TTY_OUT" 2>&1; } 2>/dev/null
    if sudo -n true >/dev/null 2>&1; then row_set admin ok "sudo"; return 0; fi
  fi
  row_set admin fix "This account can't use sudo. Sign in as an administrator, then run the setup again."
}

check_internet() {
  local host down=''
  for host in download.docker.com dl.google.com raw.githubusercontent.com; do
    net_ok "https://$host/" || down="${down:+$down, }$host"
  done
  if [ -z "$down" ]; then row_set internet ok "online"
  else row_set internet fix "Can't reach $down. Check the network connection."
  fi
}

check_disk() {
  local kib
  kib=$(free_kib "$VAR_LIB")
  case "$kib" in ''|*[!0123456789]*) kib=0 ;; esac
  if [ "$kib" -ge "$MIN_FREE_KIB" ]; then
    row_set disk ok "$((kib / 1048576)) GB free"
  else
    row_set disk fix "Only $((kib / 1048576)) GB free on /var/lib; the kiosk needs at least 10 GB."
  fi
}

check_tools() {
  local missing=''
  have_cmd curl || missing="$missing curl"
  have_cmd gpg || missing="$missing gpg"
  pkg_installed ca-certificates || missing="$missing ca-certificates"
  if [ -n "$missing" ]; then row_set tools add "will be installed:$missing"
  else row_set tools ok "curl, ca-certificates, gpg"
  fi
}

# fetch_engine: make ENGINE a readable install.sh, downloading it from
# $BASE_URL when no engine was given.
fetch_engine() {
  local tmp
  if [ -n "$ENGINE" ]; then [ -f "$ENGINE" ] && [ -r "$ENGINE" ]; return $?; fi
  tmp=$(mktemp "${TMPDIR:-/tmp}/serversherpa-install.XXXXXX") || return 1
  if download "$BASE_URL/install.sh" "$tmp" >/dev/null 2>&1 \
     && [ "$(head -n 1 "$tmp")" = '#!/usr/bin/env bash' ] && bash -n "$tmp" 2>/dev/null; then
    chmod 644 "$tmp"
    ENGINE="$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# engine_env: the environment install.sh runs with, in ENGINE_ENV.
engine_env() {
  ENGINE_ENV=(KIOSK_NONINTERACTIVE=1 "KIOSK_DIR=$KIOSK_DIR" "KIOSK_INSTALLER_REF=$INSTALLER_REF")
  [ -z "$ENGINE_DATA_DIR" ] || ENGINE_ENV+=("KIOSK_DATA_DIR=$ENGINE_DATA_DIR")
  [ -z "${KIOSK_TEMPLATE_DIR:-}" ] || ENGINE_ENV+=("KIOSK_TEMPLATE_DIR=$KIOSK_TEMPLATE_DIR")
}

# engine_checks: fill the engine-backed rows from install.sh --step check.
engine_checks() {
  local id tag state note out
  for id in $ENGINE_ROWS; do row_set "$id" -- "Not checked"; done
  [ "$(row_state admin)" != fix ] && [ "$(row_state internet)" != fix ] || return 0
  if ! fetch_engine; then
    row_set internet fix "Couldn't download the installer from $BASE_URL/install.sh."
    return 0
  fi
  engine_env
  if [ "$(row_state admin)" = ok ]; then
    out=$(as_root env "${ENGINE_ENV[@]}" bash "$ENGINE" --step check --yes </dev/null 2>/dev/null)
  else
    out=$(env "${ENGINE_ENV[@]}" bash "$ENGINE" --step check --yes </dev/null 2>/dev/null)
  fi
  while IFS='|' read -r tag id state note; do
    [ "$tag" = row ] || continue
    case " $ENGINE_ROWS " in *" $id "*) ;; *) continue ;; esac
    case "$state" in ok|add|fix) row_set "$id" "$state" "$note" ;; esac
  done <<EOF
$out
EOF
  if [ "$(row_state kiosk)" = ok ] && [ "$HAVE_CONFIG" = 1 ]; then
    row_set kiosk ok "$(row_note kiosk) ($(env_short_label "$(current_env)"))"
  fi
}

run_checks() {
  check_ubuntu
  check_admin
  check_internet
  check_disk
  check_tools
  engine_checks
}

has_problems() {
  local s
  for s in "${ROW_STATES[@]}"; do [ "$s" != fix ] || return 0; done
  return 1
}

# run_engine STEP LOG: run one install.sh step as root, stdout and stderr
# appended to LOG. stdin is /dev/null: when piped, bash is reading this script
# from stdin. The output goes through a pipe read to EOF: install.sh logs with
# `exec > >(tee …)`, which can still be writing after install.sh exits.
run_engine() {
  engine_env
  as_root env "${ENGINE_ENV[@]}" bash "$ENGINE" --step "$1" --yes ${ENGINE_ARGS[@]+"${ENGINE_ARGS[@]}"} \
    </dev/null 2>&1 | cat >>"$2"
  return "${PIPESTATUS[0]}"
}

# ── UI layer ──────────────────────────────────────────────────────────
# whiptail when it is installed and there is a terminal to answer from,
# else plain numbered prompts on the same tty. Dialogs read /dev/tty: stdin
# is this script when it is piped into bash.
UI=plain
BACKTITLE='ServerSherpa kiosk setup'
TITLE_CHECK='1 of 3: What this laptop has'
TITLE_ENV='2 of 3: Environment'
TITLE_PROGRESS='3 of 3: Installing'
PLAIN_FD_OPEN=0   # plain mode reads answers through fd 7, opened once

ui_init() {
  UI=plain
  if [ "${KIOSK_SETUP_PLAIN:-0}" != 1 ] && command -v whiptail >/dev/null 2>&1 && tty_ok; then
    UI=whiptail
  fi
}

# wt ARGS...: run whiptail on the tty; prints its answer, returns its rc.
wt() {
  local tmp rc
  tmp=$(mktemp "${TMPDIR:-/tmp}/serversherpa-wt.XXXXXX") || return 255
  { whiptail "$@" <"$TTY_IN" >"$TTY_OUT" 2>"$tmp"; } 2>/dev/null
  rc=$?
  cat "$tmp"
  rm -f "$tmp"
  return "$rc"
}

# wt_size TEXT EXTRA: "HEIGHT WIDTH" for a box holding TEXT plus EXTRA lines.
wt_size() {
  local rows=24 cols=80 size h w
  size=$({ stty size <"$TTY_IN"; } 2>/dev/null) || size=''
  case "$size" in
    *[!0123456789\ ]*|'') ;;
    *) rows=${size% *}; cols=${size#* } ;;
  esac
  w=78; [ "$w" -le $((cols - 2)) ] || w=$((cols - 2))
  # Wrapped lines, not just newlines: each line takes ceil(len / (w - 4)) rows.
  h=$(( $(printf '%s\n' "$1" | awk -v c=$((w - 4)) '{ n += (length($0) > c) ? int((length($0) + c - 1) / c) : 1 } END { print n + 0 }') + $2 ))
  [ "$h" -le $((rows - 2)) ] || h=$((rows - 2))
  printf '%s %s' "$h" "$w"
}

# plain_read VAR: one line from the tty into VAR; 1 on EOF or no tty.
plain_read() {
  local line
  if [ "$PLAIN_FD_OPEN" != 1 ]; then
    { : <"$TTY_IN"; } 2>/dev/null || return 1
    exec 7<"$TTY_IN"
    PLAIN_FD_OPEN=1
  fi
  IFS= read -r line <&7 || [ -n "$line" ] || return 1
  printf -v "$1" '%s' "$line"
}

# plain_ask PROMPT: the prompt without a newline.
plain_ask() { { printf '%s' "$1" >>"$TTY_OUT"; } 2>/dev/null || printf '%s' "$1" >&2; }

plain_title() { tty_say ''; tty_say "== $1 =="; tty_say ''; }

# ui_yesno TITLE TEXT YES_LABEL NO_LABEL: 0 = yes; 1 = no, Esc or EOF.
ui_yesno() {
  local ans size
  if [ "$UI" = whiptail ]; then
    size=$(wt_size "$2" 7)
    # shellcheck disable=SC2086  # size is "HEIGHT WIDTH"
    wt --backtitle "$BACKTITLE" --title "$1" --scrolltext --yes-button "$3" --no-button "$4" \
      --yesno "$2" $size >/dev/null || return 1   # No and Esc (255) are both 1
    return 0
  fi
  plain_title "$1"; tty_say "$2"; tty_say ''
  tty_say "1) $3"; tty_say "2) $4"
  while :; do
    plain_ask 'Choose 1 or 2: '
    plain_read ans || { tty_say ''; return 1; }
    case "$ans" in
      1) return 0 ;;
      2) return 1 ;;
    esac
    tty_say 'Type 1 or 2.'
  done
}

# ui_menu TITLE TEXT DEFAULT_TAG TAG LABEL [TAG LABEL...]: prints the chosen
# tag; 1 on cancel, Esc or EOF.
ui_menu() {
  local title="$1" text="$2" def="$3" ans n i size tags=() labels=()
  shift 3
  while [ "$#" -ge 2 ]; do tags+=("$1"); labels+=("$2"); shift 2; done
  n=${#tags[@]}
  if [ "$UI" = whiptail ]; then
    size=$(wt_size "$text" $((n + 8)))
    local args=()
    i=0
    while [ "$i" -lt "$n" ]; do args+=("${tags[$i]}" "${labels[$i]}"); i=$((i + 1)); done
    # shellcheck disable=SC2086  # size is "HEIGHT WIDTH"
    wt --backtitle "$BACKTITLE" --title "$title" --notags --default-item "$def" \
      --menu "$text" $size "$n" "${args[@]}"
    return $?
  fi
  plain_title "$title"; tty_say "$text"; tty_say ''
  i=0
  while [ "$i" -lt "$n" ]; do
    if [ "${tags[$i]}" = "$def" ]; then tty_say "$((i + 1))) ${labels[$i]} (press Enter)"
    else tty_say "$((i + 1))) ${labels[$i]}"
    fi
    i=$((i + 1))
  done
  while :; do
    plain_ask "Choose 1-$n: "
    plain_read ans || { tty_say ''; return 1; }
    if [ -z "$ans" ]; then
      i=0
      while [ "$i" -lt "$n" ]; do
        if [ "${tags[$i]}" = "$def" ]; then printf '%s' "$def"; return 0; fi
        i=$((i + 1))
      done
    else
      case "$ans" in
        *[!0123456789]*) ;;
        *) if [ "$((10#$ans))" -ge 1 ] && [ "$((10#$ans))" -le "$n" ]; then
             printf '%s' "${tags[$((10#$ans - 1))]}"; return 0
           fi ;;
      esac
    fi
    tty_say "Type a number from 1 to $n."
  done
}

# ui_msg TITLE TEXT
ui_msg() {
  local ans size
  if [ "$UI" = whiptail ]; then
    size=$(wt_size "$2" 7)
    # shellcheck disable=SC2086  # size is "HEIGHT WIDTH"
    wt --backtitle "$BACKTITLE" --title "$1" --scrolltext --msgbox "$2" $size >/dev/null
    return 0
  fi
  plain_title "$1"; tty_say "$2"; tty_say ''
  plain_ask 'Press Enter to continue. '
  plain_read ans || tty_say ''
  return 0
}

# ui_textbox TITLE FILE: a scrolling view of FILE.
ui_textbox() {
  local ans rows=24 cols=80 size
  if [ "$UI" = whiptail ]; then
    size=$({ stty size <"$TTY_IN"; } 2>/dev/null) || size=''
    case "$size" in *[!0123456789\ ]*|'') ;; *) rows=${size% *}; cols=${size#* } ;; esac
    wt --backtitle "$BACKTITLE" --title "$1" --scrolltext --textbox "$2" $((rows - 4)) $((cols - 4)) >/dev/null
    return 0
  fi
  plain_title "$1"
  { cat "$2" >>"$TTY_OUT"; } 2>/dev/null || cat "$2" >&2
  tty_say ''
  plain_ask 'Press Enter to continue. '
  plain_read ans || tty_say ''
  return 0
}

# ui_info TEXT [TITLE]: a message that stays up while work runs (no answer).
ui_info() {
  if [ "$KIOSK_SETUP_YES" = 1 ]; then printf '%s\n' "$1"; return 0; fi
  if [ "$UI" = whiptail ]; then
    wt --backtitle "$BACKTITLE" --title "${2:-$TITLE_ENV}" --infobox "$1" 8 70 >/dev/null
    return 0
  fi
  tty_say "$1"
}

# ── Screens ───────────────────────────────────────────────────────────
# checklist_text: one "MARKER  LABEL: NOTE" line per row, then what to do.
checklist_text() {
  local i=0
  while [ "$i" -lt "${#ROW_IDS[@]}" ]; do
    printf '%s  %s: %s\n' "$(row_marker "${ROW_STATES[$i]}")" "${ROW_LABELS[$i]}" "${ROW_NOTES[$i]}"
    i=$((i + 1))
  done
  printf '\n'
  if has_problems; then printf 'Fix the [ FIX ] rows, then choose Check again.\n'
  else printf '[ ADD ] rows are installed in the next steps.\n'
  fi
}

# checklist_screen: 0 = continue, 1 = quit. Check again re-runs the checks.
checklist_screen() {
  local text
  while :; do
    run_checks
    text=$(checklist_text)
    if [ "$KIOSK_SETUP_YES" = 1 ]; then
      printf '%s\n' "$text"
      if has_problems; then return 1; fi
      return 0
    fi
    if ! has_problems; then
      ui_yesno "$TITLE_CHECK" "$text" "Continue" "Quit"
      return $?
    fi
    ui_yesno "$TITLE_CHECK" "$text" "Check again" "Quit" || return 1
  done
}

# pick_env: set CHOSEN_ENV (CURRENT_ENV is set by the caller). 1 = quit.
pick_env() {
  local cur="${CURRENT_ENV:-none}" def env desc note items
  def=$cur; [ "$def" != none ] || def=prod
  # --env highlights that choice (custom only where it is offered).
  case "$OPT_ENV" in
    prod|rc|dev|edge) def=$OPT_ENV ;;
    custom) [ "$cur" != custom ] || def=custom ;;
  esac
  if [ "$KIOSK_SETUP_YES" = 1 ]; then
    env=${OPT_ENV:-$def}
    case "$env" in
      prod|rc|dev|edge) ;;
      custom) if [ "$cur" != custom ]; then
                printf "This laptop has no custom settings to keep; choose prod, rc, dev or edge.\n" >&2
                return 1
              fi ;;
      *) printf "Unknown environment '%s'; choose prod, rc, dev or edge.\n" "$env" >&2; return 1 ;;
    esac
    note=$(server_set_note "$cur" "$env")
    [ -z "$note" ] || printf '%s\n' "$note"
    CHOSEN_ENV=$env
    return 0
  fi
  while :; do
    items=()
    for env in prod rc dev edge custom; do
      [ "$env" != custom ] || [ "$cur" = custom ] || continue
      desc=$(env_desc "$env")
      [ "$env" != "$cur" ] || desc="$desc (current)"
      items+=("$env" "$(env_label "$env")  $desc")
    done
    env=$(ui_menu "$TITLE_ENV" \
      "Choose the servers and app version for this laptop. Press Enter to keep the highlighted choice." \
      "$def" "${items[@]}") || return 1
    note=$(server_set_note "$cur" "$env")
    if [ -z "$note" ] || ui_yesno "Switch servers" "$note" "Continue" "Back"; then
      CHOSEN_ENV=$env
      return 0
    fi
  done
}

# api_ok URL: 0 when URL/system/status answers; else prints the error, 1.
api_ok() {
  local err
  if have_cmd curl; then
    err=$(curl -fsS --max-time 10 "$1/system/status" -o /dev/null 2>&1) && return 0
  else
    err=$(wget -nv --timeout=10 --tries=1 -O /dev/null "$1/system/status" 2>&1) && return 0
  fi
  err=$(printf '%s\n' "$err" | awk 'NF { l = $0 } END { print l }')
  printf '%s' "${err:-no answer}"
  return 1
}

# api_check_screen: 0 = continue, 1 = quit, 2 = pick again.
api_check_screen() {
  local api label err tag
  api=$(trim_slashes "$(env_api "$CHOSEN_ENV")"); label=$(env_short_label "$CHOSEN_ENV")
  while :; do
    ui_info "Checking that the $label servers answer…"
    err=$(api_ok "$api") && return 0
    if [ "$KIOSK_SETUP_YES" = 1 ]; then
      printf "The %s servers didn't answer (%s/system/status): %s\n" "$label" "$api" "$err" >&2
      return 1
    fi
    tag=$(ui_menu "$TITLE_ENV" "$(printf "The %s servers didn't answer (%s/system/status):\n%s" "$label" "$api" "$err")" \
      retry retry "Try again" pick "Pick another environment" quit "Quit") || return 1
    case "$tag" in
      retry) ;;
      pick) return 2 ;;
      *) return 1 ;;
    esac
  done
}

# ── Progress ──────────────────────────────────────────────────────────
STEP_IDS=(tools docker docker-start chrome python3 printers download start finish)
STEP_LABELS=("Install download tools" "Install Docker Engine" "Start Docker and enable it at boot"
             "Install Google Chrome" "Install python3" "Set up USB label printers"
             "Download the kiosk app for the chosen environment"
             "Start the kiosk and wait for it to be healthy"
             "Install kiosk mode, the Start Kiosk icon, sign-in startup and nightly updates")
STEP_STATES=(pending pending pending pending pending pending pending pending pending)
STEP_LOG_DIR=''        # per-step logs; removed on exit
SETUP_STEP_LOG=''      # the log of the step running now
CURRENT_ENV=none
CHOSEN_ENV=''
KEEPALIVE_PID=''

# log_line TEXT: one timestamped (24-hour) line in SETUP_LOG.
log_line() {
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | as_root tee -a "$SETUP_LOG" >/dev/null 2>&1 || true
}

# log_file FILE: append FILE to SETUP_LOG.
log_file() { as_root tee -a "$SETUP_LOG" <"$1" >/dev/null 2>&1 || true; }

# say TEXT / say_part TEXT: progress lines, on stdout with --yes, else the tty.
say() { if [ "$KIOSK_SETUP_YES" = 1 ]; then printf '%s\n' "$1"; else tty_say "$1"; fi; }
say_part() { if [ "$KIOSK_SETUP_YES" = 1 ]; then printf '%s' "$1"; else plain_ask "$1"; fi; }

# step_needed IDX: 0 when step IDX has work to do.
step_needed() {
  case "${STEP_IDS[$1]}" in
    tools) [ "$(row_state tools)" = add ] ;;
    docker) [ "$(row_state docker)" = add ] || [ "$(row_state snapdocker)" = add ] ;;
    chrome|python3) [ "$(row_state "${STEP_IDS[$1]}")" = add ] ;;
    *) return 0 ;;
  esac
}

# snapshot_config: copy config.env and docker-compose.yml aside once per run,
# before the first download (a retry must not snapshot a half-written switch).
# The marker is a file: steps run in a background subshell.
snapshot_config() {
  local snap="$KIOSK_DIR/setup-snapshot"
  [ ! -e "$STEP_LOG_DIR/snapshot.taken" ] || return 0
  if [ -f "$KIOSK_DIR/config.env" ]; then
    as_root rm -rf "$snap" || return 1   # never mix in an earlier run's files
    as_root mkdir -p "$snap" || return 1
    as_root cp -p "$KIOSK_DIR/config.env" "$snap/config.env" || return 1
    if [ -f "$KIOSK_DIR/docker-compose.yml" ]; then
      as_root cp -p "$KIOSK_DIR/docker-compose.yml" "$snap/docker-compose.yml" || return 1
    fi
  fi
  touch "$STEP_LOG_DIR/snapshot.taken"
}

# restore_config: put the snapshot back and restart that kiosk as it was.
restore_config() {
  local snap="$KIOSK_DIR/setup-snapshot"
  ENGINE_ARGS=(); ENGINE_DATA_DIR=''
  as_root cp -p "$snap/config.env" "$KIOSK_DIR/config.env" || return 1
  if [ -f "$snap/docker-compose.yml" ]; then
    as_root cp -p "$snap/docker-compose.yml" "$KIOSK_DIR/docker-compose.yml" || return 1
  fi
  run_engine restart "$SETUP_STEP_LOG"
}

# run_setup_step IDX LOG: the install.sh steps behind progress step IDX.
run_setup_step() {
  case "${STEP_IDS[$1]}" in
    download) run_engine move-dev-data "$2" && snapshot_config && run_engine download "$2" ;;
    finish) run_engine login-items "$2" && run_engine launcher "$2" ;;
    *) run_engine "${STEP_IDS[$1]}" "$2" ;;
  esac
}

# step_reason LOG: the last "Error: " line of LOG without its prefix.
step_reason() {
  local r
  r=$(awk 'index($0, "Error: ") == 1 { l = substr($0, 8) } END { print l }' "$1" 2>/dev/null)
  printf '%s' "${r:-See the details.}"
}

# progress_percent: 100 * (done + skipped) / steps.
progress_percent() {
  local s n=0
  for s in "${STEP_STATES[@]}"; do
    case "$s" in done|skipped) n=$((n + 1)) ;; esac
  done
  printf '%s' $((100 * n / ${#STEP_IDS[@]}))
}

# progress_text: one "MARKER  LABEL" line per step, then the log path.
progress_text() {
  local i=0 m extra
  while [ "$i" -lt "${#STEP_IDS[@]}" ]; do
    extra=''
    case "${STEP_STATES[$i]}" in
      done) m='[ OK ]' ;;
      skipped) m='[ OK ]'; extra=' (already installed)' ;;
      running) m='[ .. ]' ;;
      failed) m='[FAIL]' ;;
      *) m='[    ]' ;;
    esac
    printf '%s  %s%s\n' "$m" "${STEP_LABELS[$i]}" "$extra"
    i=$((i + 1))
  done
  printf '\nLog: %s\n' "$SETUP_LOG"
}

# gauge_feed PID PERCENT: whiptail --gauge updates while PID runs.
gauge_feed() {
  local text
  text=$(progress_text)
  while :; do
    printf 'XXX\n%s\n%s\nXXX\n' "$2" "$text"
    kill -0 "$1" 2>/dev/null && [ ! -e "$STEP_LOG_DIR/step.done" ] || break
    sleep "${KIOSK_SETUP_POLL_S:-1}"
  done
}

# run_one_step IDX: run step IDX in the background with progress; its rc.
run_one_step() {
  local i="$1" log pid rc size pct
  log="$STEP_LOG_DIR/step-${STEP_IDS[$i]}.log"
  SETUP_STEP_LOG=$log
  : >"$log"
  rm -f "$STEP_LOG_DIR/step.done"
  STEP_STATES[i]=running
  ( run_setup_step "$i" "$log"; rc=$?; : >"$STEP_LOG_DIR/step.done"; exit "$rc" ) &
  pid=$!
  if [ "$UI" = whiptail ] && [ "$KIOSK_SETUP_YES" != 1 ]; then
    pct=$(progress_percent)
    size=$(wt_size "$(progress_text)" 6)
    # shellcheck disable=SC2086  # size is "HEIGHT WIDTH"
    gauge_feed "$pid" "$pct" | { whiptail --backtitle "$BACKTITLE" --title "$TITLE_PROGRESS" \
      --gauge "$(progress_text)" $size "$pct" >>"$TTY_OUT"; } 2>/dev/null
  else
    say_part "Step $((i + 1)) of ${#STEP_IDS[@]}: ${STEP_LABELS[$i]} ... "
  fi
  wait "$pid"; rc=$?
  log_line "---- step ${STEP_IDS[$i]} ----"
  log_file "$log"
  if [ "$UI" != whiptail ] || [ "$KIOSK_SETUP_YES" = 1 ]; then
    if [ "$rc" -eq 0 ]; then say "done"; else say "failed"; fi
  fi
  return "$rc"
}

# quit_after_failure IDX: put a failed switch back, say what happened; 1.
quit_after_failure() {
  local id="${STEP_IDS[$1]}" label msg
  label=$(env_short_label "$CURRENT_ENV")
  if { [ "$id" = download ] || [ "$id" = start ]; } && [ -e "$STEP_LOG_DIR/snapshot.taken" ] \
     && [ "$CURRENT_ENV" != none ] && [ "$CHOSEN_ENV" != "$CURRENT_ENV" ]; then
    ui_info "Putting this laptop back on ${label}…" "$TITLE_PROGRESS"
    SETUP_STEP_LOG="$STEP_LOG_DIR/restore.log"
    : >"$SETUP_STEP_LOG"
    if restore_config; then
      msg="The setup put this laptop back on $label, and its kiosk is running again."
    else
      msg="The setup couldn't restart the $label kiosk. Run the setup again, or see the log."
    fi
    log_line "---- restore $CURRENT_ENV ----"
    log_file "$SETUP_STEP_LOG"
  elif [ "$CURRENT_ENV" = none ]; then
    msg="The setup stopped before the kiosk was installed. Run the setup again to finish."
  else
    msg="The setup stopped. Run the setup again to finish; the kiosk keeps its current version and settings."
  fi
  msg=$(printf '%s\n\nLog: %s' "$msg" "$SETUP_LOG")
  log_line "Stopped: ${msg%%$'\n'*}"
  if [ "$KIOSK_SETUP_YES" = 1 ]; then printf '%s\n' "$msg"
  else ui_msg "Setup stopped" "$msg"
  fi
  return 1
}

# run_steps: 0 = all done, 1 = quit. Try again re-runs only the failed step.
run_steps() {
  local i=0 n=${#STEP_IDS[@]} reason text tag
  while [ "$i" -lt "$n" ]; do
    [ "${STEP_STATES[$i]}" != pending ] || step_needed "$i" || STEP_STATES[i]=skipped
    i=$((i + 1))
  done
  i=0
  while [ "$i" -lt "$n" ]; do
    case "${STEP_STATES[$i]}" in
      done) i=$((i + 1)); continue ;;
      skipped)
        [ "$UI" = whiptail ] && [ "$KIOSK_SETUP_YES" != 1 ] \
          || say "Step $((i + 1)) of $n: ${STEP_LABELS[$i]} (already installed)"
        i=$((i + 1)); continue ;;
    esac
    if run_one_step "$i"; then STEP_STATES[i]="done"; i=$((i + 1)); continue; fi
    STEP_STATES[i]=failed
    reason=$(step_reason "$SETUP_STEP_LOG")
    log_line "Step $((i + 1)) failed: ${STEP_LABELS[$i]}: $reason"
    if [ "$KIOSK_SETUP_YES" = 1 ]; then
      printf 'Step %s failed: %s: %s\n' "$((i + 1))" "${STEP_LABELS[$i]}" "$reason" >&2
      quit_after_failure "$i"
      return 1
    fi
    text=$(printf 'Step %s failed: %s\n\n%s\n\nLog: %s' "$((i + 1))" "${STEP_LABELS[$i]}" "$reason" "$SETUP_LOG")
    while :; do
      tag=$(ui_menu "$TITLE_PROGRESS" "$text" retry retry "Try again" details "Show details" quit "Quit") || tag=quit
      case "$tag" in
        retry) break ;;
        details) ui_textbox "Details: ${STEP_LABELS[$i]}" "$SETUP_STEP_LOG" ;;
        *) quit_after_failure "$i"; return 1 ;;
      esac
    done
    STEP_STATES[i]=pending
  done
  return 0
}

# finish_screen: the Done screen; Restart now reboots.
finish_screen() {
  local text
  as_root rm -rf "$KIOSK_DIR/setup-snapshot" >/dev/null 2>&1 || true
  log_line "Done."
  text=$(printf 'Done. Sign out and back in (or restart) to start the kiosk.\n\nLog: %s' "$SETUP_LOG")
  if [ "$KIOSK_SETUP_YES" = 1 ]; then printf '%s\n' "$text"; return 0; fi
  if ui_yesno "Done" "$text" "Restart now" "Close"; then
    log_line "Restarting the laptop."
    as_root systemctl reboot
  fi
  return 0
}

# ── Main ──────────────────────────────────────────────────────────────
OPT_HELP=0

usage() {
  cat <<'EOF'
Usage: setup.sh [--env prod|rc|dev|edge|custom] [--yes] [--help]

Sets up this Ubuntu laptop as a ServerSherpa kiosk: shows what is installed
and what is missing, lets you pick the environment, then installs with
progress and Try again.

  --env NAME   the environment: prod (default on a new laptop), rc, dev, edge,
               or custom (keep this laptop's current settings)
  --yes        no questions: stop on any problem (use with --env)
  --help       show this help

Exit codes: 0 done, 1 quit or failure, 2 bad usage.
EOF
}

# parse_args ARGS...: sets OPT_ENV, KIOSK_SETUP_YES and OPT_HELP; 2 = bad usage.
parse_args() {
  local env
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env|--env=*)
        if [ "$1" = --env ]; then env="${2-}"; [ "$#" -lt 2 ] || shift
        else env="${1#--env=}"
        fi
        case "$env" in
          prod|rc|dev|edge|custom) OPT_ENV=$env ;;
          *) printf "Unknown environment '%s' (use prod, rc, dev, edge or custom).\n" "$env" >&2; return 2 ;;
        esac ;;
      --yes|-y) KIOSK_SETUP_YES=1 ;;
      --help|-h) OPT_HELP=1 ;;
      *) printf "Unknown option '%s'. Try --help.\n" "$1" >&2; return 2 ;;
    esac
    shift
  done
}

cleanup() {
  if [ -n "$KEEPALIVE_PID" ]; then
    pkill -P "$KEEPALIVE_PID" sleep 2>/dev/null   # its sleep first, or the sleep outlives it
    kill "$KEEPALIVE_PID" 2>/dev/null || true
    KEEPALIVE_PID=''
  fi
  [ -z "$STEP_LOG_DIR" ] || rm -rf "$STEP_LOG_DIR"
  # An install.sh that fetch_engine downloaded (not one given with the hook).
  [ -z "$ENGINE" ] || [ "$ENGINE" = "${KIOSK_SETUP_ENGINE:-}" ] || rm -f "$ENGINE"
}

# start_sudo_keepalive: keep sudo's cached credentials fresh during the install.
start_sudo_keepalive() {
  ! is_root && [ "$(row_state admin)" = ok ] || return 0
  ( while sleep "${KIOSK_SUDO_KEEPALIVE_S:-50}"; do sudo -n -v >/dev/null 2>&1 || exit 0; done ) \
    </dev/null >/dev/null 2>&1 &
  KEEPALIVE_PID=$!
}

main() {
  local rc
  parse_args "$@" || return 2
  if [ "$OPT_HELP" = 1 ]; then usage; return 0; fi
  if [ "$KIOSK_SETUP_YES" != 1 ] && ! tty_ok; then
    printf 'This setup asks questions on a terminal. Run it in a terminal, or pass --env NAME --yes.\n' >&2
    return 1
  fi
  STEP_LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/serversherpa-setup.XXXXXX") || return 1
  trap cleanup EXIT
  ui_init
  [ "$KIOSK_SETUP_YES" != 1 ] || UI=plain
  load_saved_config
  CURRENT_ENV=$(current_env)
  checklist_screen || return 1
  as_root touch "$SETUP_LOG" && as_root chmod 644 "$SETUP_LOG"
  log_line "---- setup.sh $* ----"
  start_sudo_keepalive
  while :; do
    pick_env || return 1
    log_line "Environment: $(env_short_label "$CHOSEN_ENV") (was $(env_short_label "$CURRENT_ENV"))"
    set_engine_args "$CHOSEN_ENV"
    api_check_screen; rc=$?
    case "$rc" in
      0) break ;;
      2) ;;
      *) return 1 ;;
    esac
  done
  run_steps || return 1
  finish_screen
}

if [ "${KIOSK_SETUP_LIB:-0}" != 1 ]; then main "$@"; exit $?; fi
