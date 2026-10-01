#!/usr/bin/env bash
# ServerSherpa kiosk installer (laptop edition) for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.sh | bash
#   bash kiosk_laptop/installer/install.sh          # from a checkout
#
# Options:
#   --api-url URL      cloud API URL (default https://api.serversherpa.com)
#   --portal-url URL   portal URL (default: the API URL with api. -> portal.)
#   --channel NAME     stable (default) or edge
#   --yes              never prompt
#   --uninstall        remove the kiosk (the data folder is kept)
#   --purge-data       with --uninstall, also delete the data folder (asks you to type DELETE)
#   --start-fresh      don't look for a phase-1 kiosk's data (it gets a new identity)
#   --help             show this help
#
# Environment overrides:
#   KIOSK_DIR              install folder (default: see default_dirs)
#   KIOSK_DATA_DIR         data folder    (default: see default_dirs)
#   KIOSK_IMAGE            full image reference (tests and CI)
#   KIOSK_INSTALLER_REF    git ref the companion files are fetched from (default main)
#   KIOSK_NONINTERACTIVE   1 = never prompt
#
# Testing hooks (not for normal use):
#   KIOSK_TTY              file to read answers from instead of /dev/tty
#   KIOSK_TEMPLATE_DIR     read companion files from this folder instead of downloading
#   KIOSK_INSTALL_LIB=1    define the functions without running main
#
# Written for bash 3.2 (macOS's bash).
# shellcheck disable=SC2034  # globals set here are read by later steps of the installer
set -euo pipefail

# ── Output helpers ────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_BLUE=$'\033[34m'; C_YEL=$'\033[33m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_BOLD=''; C_BLUE=''; C_YEL=''; C_RED=''; C_OFF=''
fi
info() { printf '%s==>%s %s\n' "$C_BLUE$C_BOLD" "$C_OFF" "$*"; }
warn() { printf '%sWarning:%s %s\n' "$C_YEL$C_BOLD" "$C_OFF" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$C_RED$C_BOLD" "$C_OFF" "$*" >&2; exit 1; }

# ── Globals ───────────────────────────────────────────────────────────
OS=''            # Darwin | Linux
ARCH=''          # amd64 | arm64
OS_VERSION=''
# Remember what the environment set before default_dirs fills the blanks, so a
# saved custom data folder can win over the OS default (but not over the env).
ENV_DATA_DIR_SET=0
[ -z "${KIOSK_DATA_DIR:-}" ] || ENV_DATA_DIR_SET=1
# The folders as the environment gave them (forwarded through sudo as-is).
ORIG_KIOSK_DIR="${KIOSK_DIR:-}"
ORIG_KIOSK_DATA_DIR="${KIOSK_DATA_DIR:-}"
KIOSK_DIR="${KIOSK_DIR:-}"
KIOSK_DATA_DIR="${KIOSK_DATA_DIR:-}"
CFG_API_URL=''
CFG_PORTAL_URL=''
CFG_CHANNEL=''
CFG_DATA_DIR=''
OPT_API_URL="${OPT_API_URL:-}"
OPT_PORTAL_URL="${OPT_PORTAL_URL:-}"
OPT_CHANNEL="${OPT_CHANNEL:-}"
DO_UNINSTALL=0
PURGE_DATA=0
START_FRESH=0    # --start-fresh: skip a phase-1 kiosk's data knowingly
LEGACY_DIR=''         # phase-1 data to copy (find_legacy_data)
LEGACY_UNREADABLE=''  # a phase-1 container's /data folder this script can't read
TTY_PATH="${KIOSK_TTY:-/dev/tty}"
DOCKER=(docker)
TMP_FILES=()     # temp files to remove on exit (see cleanup)
HAS_SYSTEMD="${HAS_SYSTEMD:-}"   # 1/0; detected by check_minimums when blank
BROWSER_BIN=''                   # Chrome/Chromium/Edge (a .app path on macOS)
KIOSK_IDENTITY=''                # /edge/identity JSON, read by start_kiosk
ADDED_DOCKER_GROUP=0
HEALTH_POLL_S="${HEALTH_POLL_S:-3}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
ENGINE_POLL_S="${ENGINE_POLL_S:-3}"

DEFAULT_API_URL='https://api.serversherpa.com'
LEGACY_PROJECT='serversherpa-kiosk-laptop'
LEGACY_FILTER="label=com.docker.compose.project=$LEGACY_PROJECT"
KIOSK_CONTAINER='serversherpa-kiosk-edge-1'   # project "serversherpa-kiosk", service "edge"
PREVIOUS_TAG='serversherpa-kiosk-laptop:previous'   # kept by update.sh
KIOSK_URL='http://localhost:8090'

DMG_MOUNT=''     # Docker Desktop disk image mount point while attached

cleanup() {
  local f
  if [ -n "$DMG_MOUNT" ]; then
    hdiutil detach -quiet "$DMG_MOUNT" >/dev/null 2>&1 || true
    rmdir "$DMG_MOUNT" 2>/dev/null || true
  fi
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do rm -f "$f"; done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

is_root() { [ "$(id -u)" -eq 0 ]; }

# Run a command as root: directly when root, else through sudo.
as_root() {
  if is_root; then
    "$@"
  else
    command -v sudo >/dev/null 2>&1 || die "This step needs root and sudo is not installed: $*"
    sudo "$@"
  fi
}

# True when we may prompt: not forced non-interactive and the tty opens.
interactive() {
  [ "${KIOSK_NONINTERACTIVE:-0}" != 1 ] || return 1
  { : <"$TTY_PATH"; } 2>/dev/null
}

# Answers come from fd 3 and prompts go to fd 4, both opened once on the tty
# (in tests, fd 3 is KIOSK_TTY and fd 4 is stderr), so stdin and stdout can be
# a curl pipe and a log file while the person still sees the prompts.
open_tty() {
  exec 3<"$TTY_PATH"
  if [ -n "${KIOSK_TTY:-}" ]; then exec 4>&2; else exec 4>"$TTY_PATH"; fi
}
close_tty() { exec 3<&- 4>&-; }

die_eof() { die "Input ended before the prompts were answered. Run the installer in a terminal, or pass --yes."; }

ask() {  # ask VAR "prompt"  -> visible answer; returns 1 on EOF
  local _a
  printf '%s' "$2" >&4
  IFS= read -r -u 3 _a || return 1
  eval "$1=\$_a"
}

usage() {
  cat <<'EOF'
ServerSherpa kiosk installer (laptop edition) for macOS and Linux.

  curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/kiosk_laptop/installer/install.sh | bash
  curl -fsSL .../install.sh | bash -s -- --channel edge
  bash kiosk_laptop/installer/install.sh          # from a checkout

Options:
  --api-url URL      cloud API URL (default https://api.serversherpa.com)
  --portal-url URL   portal URL (default: the API URL with api. -> portal.)
  --channel NAME     stable (default) or edge
  --yes              never prompt
  --uninstall        remove the kiosk (the data folder is kept)
  --purge-data       with --uninstall, also delete the data folder (asks you to type DELETE)
  --start-fresh      don't look for a phase-1 kiosk's data (it gets a new identity)
  --help             show this help

Environment: KIOSK_DIR, KIOSK_DATA_DIR, KIOSK_IMAGE, KIOSK_INSTALLER_REF,
KIOSK_NONINTERACTIVE.
EOF
}

# ── Companion files ───────────────────────────────────────────────────
BASE_URL="https://raw.githubusercontent.com/encondata/BaseCampV3/${KIOSK_INSTALLER_REF:-main}/kiosk_laptop/installer"

# fetch_companion NAME DEST: copy from KIOSK_TEMPLATE_DIR, else download.
fetch_companion() {
  local name="$1" dest="$2"
  if [ -n "${KIOSK_TEMPLATE_DIR:-}" ]; then
    [ -f "$KIOSK_TEMPLATE_DIR/$name" ] || die "Missing $KIOSK_TEMPLATE_DIR/$name"
    cp "$KIOSK_TEMPLATE_DIR/$name" "$dest"
  else
    curl -fsSL "$BASE_URL/$name" -o "$dest" || die "Couldn't download $BASE_URL/$name"
  fi
}

# ── Platform ──────────────────────────────────────────────────────────
detect_os() {
  OS=$(uname -s)
  case "$OS" in
    Darwin) OS_VERSION=$(sw_vers -productVersion 2>/dev/null || echo unknown) ;;
    Linux)
      OS_VERSION=unknown
      if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091  # runtime file, not a script to lint
        OS_VERSION=$(. /etc/os-release && printf '%s' "${VERSION_ID:-unknown}")
      fi
      ;;
    *) die "Unsupported OS '$OS'. This installer supports macOS and Linux." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "Unsupported CPU architecture '$(uname -m)'." ;;
  esac
  # Under Rosetta, uname -m says x86_64 on Apple silicon.
  if [ "$OS" = Darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
    ARCH=arm64
  fi
}

default_dirs() {
  if [ "$OS" = Darwin ]; then
    : "${KIOSK_DIR:=/Library/Application Support/ServerSherpaKiosk}"
    # /Users/Shared: Docker Desktop shares /Users by default, not /Library.
    : "${KIOSK_DATA_DIR:=/Users/Shared/ServerSherpaKiosk/data}"
  else
    : "${KIOSK_DIR:=/opt/serversherpa-kiosk}"
    : "${KIOSK_DATA_DIR:=/var/lib/serversherpa-kiosk}"
  fi
}

# ── Configuration ─────────────────────────────────────────────────────
# derive_portal_url API_URL: replace a leading api. host label with portal.
derive_portal_url() {
  local u="${1%/}" scheme rest
  case "$u" in
    https://api.*) scheme=https:// ; rest=${u#https://api.} ;;
    http://api.*)  scheme=http:// ; rest=${u#http://api.} ;;
    *) return 0 ;;
  esac
  [ -n "$rest" ] || return 0
  printf '%sportal.%s' "$scheme" "$rest"
}

# load_config FILE: read the four keys without executing the file.
load_config() {
  local file="$1"
  CFG_API_URL=''; CFG_PORTAL_URL=''; CFG_CHANNEL=''; CFG_DATA_DIR=''
  [ -f "$file" ] || return 0
  CFG_API_URL=$(config_value "$file" EDGE_CLOUD_API_URL)
  CFG_PORTAL_URL=$(config_value "$file" EDGE_PORTAL_URL)
  CFG_CHANNEL=$(config_value "$file" KIOSK_CHANNEL)
  CFG_DATA_DIR=$(config_value "$file" KIOSK_DATA_DIR)
}

config_value() {  # config_value FILE KEY -> value of the first KEY= line
  local line
  line=$(grep -E "^$2=" "$1" | head -n 1 || true)
  printf '%s' "${line#*=}"
}

check_url_scheme() {  # check_url_scheme LABEL URL
  case "$2" in
    http://?*|https://?*) ;;
    *) die "$1 must start with http:// or https:// (got '$2')." ;;
  esac
}

# uninstall_data_dir: the data folder uninstall works on (environment, then the
# saved config, then the OS default). Nothing else is read or checked, so a
# damaged setting can't block uninstall. Call after default_dirs and load_config.
uninstall_data_dir() {
  if [ "$ENV_DATA_DIR_SET" = 1 ] || [ -z "$CFG_DATA_DIR" ]; then
    printf '%s' "$KIOSK_DATA_DIR"
  else
    printf '%s' "$CFG_DATA_DIR"
  fi
}

# merge_config: flags/env beat the saved config beat the defaults.
merge_config() {
  local opt_api="$OPT_API_URL" saved_api="$CFG_API_URL" changed=0
  while [ "${opt_api%/}" != "$opt_api" ]; do opt_api="${opt_api%/}"; done
  while [ "${saved_api%/}" != "$saved_api" ]; do saved_api="${saved_api%/}"; done
  [ -z "$opt_api" ] || [ "$opt_api" = "$saved_api" ] || changed=1
  CFG_API_URL="${opt_api:-$saved_api}"
  [ -n "$CFG_API_URL" ] || CFG_API_URL="$DEFAULT_API_URL"
  CFG_PORTAL_URL="${CFG_PORTAL_URL%/}"
  if [ -n "$OPT_PORTAL_URL" ]; then
    CFG_PORTAL_URL="${OPT_PORTAL_URL%/}"
  elif [ "$changed" = 1 ] || [ -z "$CFG_PORTAL_URL" ]; then
    # Re-derive only when the API URL changed (or nothing was saved).
    CFG_PORTAL_URL=$(derive_portal_url "$CFG_API_URL")
    [ -n "$CFG_PORTAL_URL" ] \
      || warn "Can't derive a portal URL from $CFG_API_URL; links to the portal won't work until you pass --portal-url."
  fi
  check_url_scheme "The API URL" "$CFG_API_URL"
  [ -z "$CFG_PORTAL_URL" ] || check_url_scheme "The portal URL" "$CFG_PORTAL_URL"
  [ -z "$OPT_CHANNEL" ] || CFG_CHANNEL="$OPT_CHANNEL"
  [ -n "$CFG_CHANNEL" ] || CFG_CHANNEL=stable
  case "$CFG_CHANNEL" in
    stable|edge) ;;
    *) die "Unknown channel '$CFG_CHANNEL' (use stable or edge)." ;;
  esac
  # Data folder: environment, then saved config, then the OS default.
  if [ "$ENV_DATA_DIR_SET" = 1 ] || [ -z "$CFG_DATA_DIR" ]; then
    CFG_DATA_DIR="$KIOSK_DATA_DIR"
  else
    KIOSK_DATA_DIR="$CFG_DATA_DIR"
  fi
  return 0
}

# A value goes into an env file read by compose: no newline, quote or $.
check_config_value() {  # check_config_value NAME VALUE
  case "$2" in
    *$'\n'*|*$'\r'*|*"'"*|*'"'*|*'$'*) die "$1 contains a newline, quote or \$ character, which isn't allowed." ;;
  esac
}

# The data folder also lands in a YAML string and a host:/data volume spec.
check_data_dir() {
  check_config_value "Data folder" "$1"
  case "$1" in
    *\\*|*:*) die "The data folder can't contain a backslash or colon: $1" ;;
  esac
}

# write_config FILE: the settings plus the browser launch.sh opens, KEY=value,
# mode 644 (no secrets in it).
write_config() {
  local file="$1" tmp
  check_config_value "API URL" "$CFG_API_URL"
  check_config_value "Portal URL" "$CFG_PORTAL_URL"
  check_config_value "Channel" "$CFG_CHANNEL"
  check_config_value "Browser" "$BROWSER_BIN"
  check_data_dir "$CFG_DATA_DIR"
  tmp=$(mktemp "$file.XXXXXX")
  TMP_FILES+=("$tmp")
  chmod 644 "$tmp"   # URLs only; the macOS update job runs as the signed-in user
  {
    printf 'EDGE_CLOUD_API_URL=%s\n' "$CFG_API_URL"
    printf 'EDGE_PORTAL_URL=%s\n' "$CFG_PORTAL_URL"
    printf 'KIOSK_CHANNEL=%s\n' "$CFG_CHANNEL"
    printf 'KIOSK_DATA_DIR=%s\n' "$CFG_DATA_DIR"
    printf 'KIOSK_BROWSER=%s\n' "$BROWSER_BIN"
  } >"$tmp"
  mv "$tmp" "$file"
}

image_ref() {
  printf '%s' "${KIOSK_IMAGE:-ghcr.io/encondata/serversherpa-kiosk-laptop:$CFG_CHANNEL}"
}

# render_compose FILE: the runtime compose file from the template.
render_compose() {
  local file="$1" tpl image data
  tpl=$(mktemp "${TMPDIR:-/tmp}/kiosk-compose.XXXXXX")
  TMP_FILES+=("$tpl")
  fetch_companion docker-compose.yml "$tpl"
  image=$(image_ref)
  data="$KIOSK_DATA_DIR"
  check_config_value "Image" "$image"
  check_data_dir "$data"
  # Substitute with awk (ENVIRON) so '&', '/' and '\' in paths stay literal.
  IMG="$image" DATA="$data" awk '
    {
      while ((i = index($0, "__IMAGE__")) > 0)
        $0 = substr($0, 1, i - 1) ENVIRON["IMG"] substr($0, i + 9)
      while ((i = index($0, "__DATA_DIR__")) > 0)
        $0 = substr($0, 1, i - 1) ENVIRON["DATA"] substr($0, i + 12)
      print
    }
  ' "$tpl" >"$file"
  chmod 644 "$file"   # read by the macOS update job, which runs as the signed-in user
}

# ── Phase-1 data migration ────────────────────────────────────────────
# Home of the person who ran sudo, else the current user's.
home_of_user() {
  local h=''
  if [ -n "${SUDO_USER:-}" ]; then
    case "$SUDO_USER" in
      *[!A-Za-z0-9._-]*) ;;
      *) h=$(eval "printf '%s' ~$SUDO_USER" 2>/dev/null || true) ;;
    esac
    case "$h" in "~"*) h='' ;; esac
  fi
  printf '%s' "${h:-$HOME}"
}

# The phase-1 kiosk's containers, found by their compose project label (not
# `compose -p … stop`, which depends on the folder it runs in).
legacy_container_ids() {
  "${DOCKER[@]}" ps -a -q --filter "$LEGACY_FILTER" 2>/dev/null || true
}

# legacy_mount_source ID: the host folder that container mounts at /data.
legacy_mount_source() {
  "${DOCKER[@]}" inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$1" 2>/dev/null || true
}

# The phase-1 kiosk holds port 8090; stop it (nothing to stop is fine).
stop_legacy_kiosk() {
  local ids
  ids=$(legacy_container_ids)
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086  # one container id per word
  "${DOCKER[@]}" stop $ids >/dev/null 2>&1 || true
}

# find_legacy_data: sets LEGACY_DIR to the phase-1 data folder if it holds
# identity.json. The old container's /data mount wins over the home-folder
# guess (the guess is only for when no old container exists); a mount this
# script can't read sets LEGACY_UNREADABLE instead.
find_legacy_data() {
  local ids id src=''
  LEGACY_DIR=''; LEGACY_UNREADABLE=''
  if [ -n "${EDGE_DATA_HOST_DIR:-}" ]; then
    [ ! -f "$EDGE_DATA_HOST_DIR/identity.json" ] || LEGACY_DIR="$EDGE_DATA_HOST_DIR"
    return 0
  fi
  ids=$(legacy_container_ids)
  for id in $ids; do
    src=$(legacy_mount_source "$id")
    [ -z "$src" ] || break
  done
  if [ -n "$src" ]; then
    # Older Docker Desktop for Mac reports host folders under /host_mnt.
    case "$src" in /host_mnt/*) [ -d "$src" ] || src="${src#/host_mnt}" ;; esac
    if [ -d "$src" ]; then
      [ ! -f "$src/identity.json" ] || LEGACY_DIR="$src"
    else
      LEGACY_UNREADABLE="$src"
    fi
    return 0
  fi
  src="${HOME_OF_USER:-$(home_of_user)}/ServerSherpaKiosk"
  [ ! -f "$src/identity.json" ] || LEGACY_DIR="$src"
}

# migrate_legacy_data: one-time copy into an empty data folder. Stops before
# the new kiosk starts when the old data can't be read (unless --start-fresh).
migrate_legacy_data() {
  local legacy
  find_legacy_data
  legacy="${LEGACY_DIR:-$LEGACY_UNREADABLE}"
  [ -n "$legacy" ] || return 0
  if [ "$START_FRESH" = 1 ]; then
    warn "Starting fresh (--start-fresh): the earlier kiosk's data in $legacy was not copied."
    return 0
  fi
  # Only into a missing or completely empty folder; never overwrite anything.
  if [ -d "$KIOSK_DATA_DIR" ] && [ -n "$(ls -A "$KIOSK_DATA_DIR" 2>/dev/null)" ]; then
    info "Keeping the existing data in $KIOSK_DATA_DIR (earlier kiosk data in $legacy was not copied)."
    return 0
  fi
  if [ -n "$LEGACY_UNREADABLE" ]; then
    stop_legacy_kiosk
    die "The earlier kiosk keeps its data in $LEGACY_UNREADABLE, which this installer can't read. The old kiosk was stopped. Copy everything in that folder into $KIOSK_DATA_DIR, then re-run this command. To start without it (the kiosk gets a new identity, and scans the old one hadn't uploaded stay behind), re-run with --start-fresh."
  fi
  info "Found the earlier kiosk data in $legacy; copying it to $KIOSK_DATA_DIR"
  stop_legacy_kiosk
  mkdir -p "$KIOSK_DATA_DIR"
  cp -Rp "$legacy"/. "$KIOSK_DATA_DIR"/
  info "The old folder $legacy was left in place; you can delete it once the kiosk works."
}

# ── Preflight ─────────────────────────────────────────────────────────
# ensure_root ARGS...: re-run this script through sudo (once) unless root.
# Under `curl | bash` there is no script file, so fetch a copy to run.
self_script() { printf '%s' "${BASH_SOURCE[0]:-}"; }  # this file, if it is one

ensure_root() {
  is_root && return 0
  command -v sudo >/dev/null 2>&1 || die "This installer needs root. Run it as root, or install sudo and re-run."
  local script v rc=0
  local envs=()
  script=$(self_script)
  if [ -z "$script" ] || [ ! -f "$script" ]; then
    [ -n "${KIOSK_INSTALLER_REF:-}" ] \
      || info "Using the installer from the main branch (set KIOSK_INSTALLER_REF to use another)."
    script=$(mktemp "${TMPDIR:-/tmp}/kiosk-install.XXXXXX")
    TMP_FILES+=("$script")
    fetch_companion install.sh "$script"
  fi
  for v in KIOSK_INSTALLER_REF KIOSK_IMAGE KIOSK_NONINTERACTIVE KIOSK_TEMPLATE_DIR \
           KIOSK_CONFIRM_PURGE KIOSK_TTY EDGE_DATA_HOST_DIR; do
    [ -z "${!v:-}" ] || envs+=("$v=${!v}")
  done
  [ -z "$ORIG_KIOSK_DIR" ] || envs+=("KIOSK_DIR=$ORIG_KIOSK_DIR")
  [ -z "$ORIG_KIOSK_DATA_DIR" ] || envs+=("KIOSK_DATA_DIR=$ORIG_KIOSK_DATA_DIR")
  info "Administrator rights are needed; sudo may ask for your password."
  # stdin from /dev/null: under curl | bash it is the script pipe. Prompts use the tty.
  sudo env ${envs[@]+"${envs[@]}"} bash "$script" "$@" </dev/null || rc=$?
  exit "$rc"
}

# check_minimums: macOS 13+ (Docker Desktop), Linux with systemd.
check_minimums() {
  local major
  case "$OS" in
    Darwin)
      major="${OS_VERSION%%.*}"
      case "$major" in ''|*[!0-9]*) major=0 ;; esac
      [ "$major" -ge 13 ] || die "macOS 13 or later is required (this Mac has $OS_VERSION). Update macOS, then re-run."
      ;;
    Linux)
      if [ -z "$HAS_SYSTEMD" ]; then
        if [ -d /run/systemd/system ]; then HAS_SYSTEMD=1; else HAS_SYSTEMD=0; fi
      fi
      [ "$HAS_SYSTEMD" = 1 ] || die "This Linux system doesn't run systemd, which the kiosk needs to start Docker and its nightly update."
      ;;
  esac
}

# find_browser: sets BROWSER_BIN to Chrome, then Chromium/Edge; warns if none.
find_browser() {
  local c
  BROWSER_BIN=''
  if [ "$OS" = Darwin ]; then
    for c in "/Applications/Google Chrome.app" "/Applications/Microsoft Edge.app" "/Applications/Chromium.app"; do
      if [ -d "$c" ]; then BROWSER_BIN="$c"; break; fi
    done
  else
    for c in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
      if command -v "$c" >/dev/null 2>&1; then BROWSER_BIN=$(command -v "$c"); break; fi
    done
  fi
  [ -n "$BROWSER_BIN" ] \
    || warn "No Chrome, Chromium or Edge found. Install Google Chrome (https://www.google.com/chrome/) so the kiosk opens at sign-in."
  return 0
}

preflight() {
  ensure_root "$@"
  check_minimums
  find_browser
}

# The signed-in person Docker Desktop and the login items belong to.
desktop_user() {
  local u="${SUDO_USER:-}"
  if [ -z "$u" ] || [ "$u" = root ]; then
    u=''
    if [ "$OS" = Darwin ]; then
      u=$(stat -f %Su /dev/console 2>/dev/null || true)
      [ "$u" != root ] || u=''
    fi
  fi
  printf '%s' "$u"
}

# ── Settings ──────────────────────────────────────────────────────────
# prompt_settings: ask for the URLs nobody has set yet (between load and merge).
prompt_settings() {
  local ans derived need_api=0 need_portal=0
  [ -n "$OPT_API_URL" ] || [ -n "$CFG_API_URL" ] || need_api=1
  [ -n "$OPT_PORTAL_URL" ] || [ -n "$CFG_PORTAL_URL" ] || need_portal=1
  [ "$need_api$need_portal" != 00 ] || return 0
  interactive || return 0
  open_tty
  if [ "$need_api" = 1 ]; then
    ask ans "ServerSherpa API URL [$DEFAULT_API_URL]: " || die_eof
    OPT_API_URL="${ans:-$DEFAULT_API_URL}"
  fi
  if [ "$need_portal" = 1 ]; then
    derived=$(derive_portal_url "${OPT_API_URL:-${CFG_API_URL:-$DEFAULT_API_URL}}")
    ask ans "Portal URL [${derived:-none}]: " || die_eof
    [ -z "$ans" ] || OPT_PORTAL_URL="$ans"
  fi
  close_tty
}

check_api_reachable() {
  if curl -fsS --max-time 5 "$CFG_API_URL/system/status" >/dev/null 2>&1; then
    info "ServerSherpa answers at $CFG_API_URL"
  else
    warn "Couldn't reach $CFG_API_URL/system/status. Continuing; the kiosk works offline and connects once the network is up."
  fi
}

# ── Docker ────────────────────────────────────────────────────────────
DOCKER_APP='/Applications/Docker.app'
DOCKER_DESKTOP_BIN="$DOCKER_APP/Contents/Resources/bin"

# setup_docker_cli: how this script runs docker. Linux: as root. macOS: as the
# Docker Desktop user, whose ~/.docker holds the compose plugin path and
# credential helpers (root's CLI has neither, and must not litter that folder).
setup_docker_cli() {
  local user
  if [ "$OS" = Darwin ]; then
    PATH="$PATH:/usr/local/bin:$DOCKER_DESKTOP_BIN"
    export PATH
    user=$(desktop_user)
    [ -n "$user" ] || die "No signed-in user found. Sign in to this Mac and run the command from your own account."
    DOCKER=(sudo -u "$user" -H env "PATH=$PATH" docker)
  else
    DOCKER=(docker)
  fi
}

docker_answers() { "${DOCKER[@]}" version >/dev/null 2>&1; }

# ensure_docker: install Docker Desktop (macOS) or Docker Engine (Linux) if missing.
ensure_docker() {
  if [ "$OS" = Darwin ]; then
    if docker_answers || [ -d /Applications/Docker.app ]; then
      info "Docker Desktop is installed."
      return 0
    fi
    install_docker_desktop
  else
    if command -v docker >/dev/null 2>&1; then
      info "Docker is installed."
    else
      info "Installing Docker Engine (get.docker.com)"
      curl -fsSL https://get.docker.com | sh || die "Docker Engine didn't install. See the messages above, then re-run."
    fi
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && getent group docker >/dev/null 2>&1; then
      if ! id -nG "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        if usermod -aG docker "$SUDO_USER"; then
          ADDED_DOCKER_GROUP=1
        else
          warn "Couldn't add $SUDO_USER to the docker group; the kiosk still works, but docker needs sudo."
        fi
      fi
    fi
  fi
}

install_docker_desktop() {
  local user dmg
  user=$(desktop_user)
  [ -n "$user" ] || die "Run this installer from your own account (with sudo), not as root, so Docker Desktop is set up for you."
  dmg=$(mktemp "${TMPDIR:-/tmp}/Docker.XXXXXX")
  TMP_FILES+=("$dmg")
  info "Downloading Docker Desktop ($ARCH)"
  curl -fL --progress-bar "https://desktop.docker.com/mac/main/$ARCH/Docker.dmg" -o "$dmg" \
    || die "Couldn't download Docker Desktop. Check the network, then re-run."
  DMG_MOUNT=$(mktemp -d "${TMPDIR:-/tmp}/kiosk-docker-dmg.XXXXXX")   # cleanup detaches it
  hdiutil attach -nobrowse -quiet -mountpoint "$DMG_MOUNT" "$dmg" || die "Couldn't open the Docker Desktop disk image."
  info "Installing Docker Desktop for $user"
  "$DMG_MOUNT/Docker.app/Contents/MacOS/install" --accept-license --user="$user" \
    || die "Docker Desktop didn't install. See the messages above, then re-run."
  hdiutil detach -quiet "$DMG_MOUNT" || true
  rmdir "$DMG_MOUNT" 2>/dev/null || true
  DMG_MOUNT=''
}

# python3 path for JSON, but not macOS's /usr/bin/python3 stub when the
# command line tools are missing (it pops an install dialog instead).
python_bin() {
  local py
  py=$(command -v python3 2>/dev/null) || return 1
  if [ "$OS" = Darwin ] && [ "$py" = /usr/bin/python3 ]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  printf '%s' "$py"
}

# set_docker_autostart FILE [USER]: "AutoStart": true, every other key kept,
# written as USER (when given) so the file and its folder stay theirs.
# Without python3 the file is only created when missing, never rewritten.
set_docker_autostart() {
  local file="$1" py
  local as_user=()
  local manual="In Docker Desktop › Settings › General, turn on Start Docker Desktop when you sign in."
  [ -z "${2:-}" ] || as_user=(sudo -u "$2" -H)
  ${as_user[@]+"${as_user[@]}"} mkdir -p "$(dirname "$file")" || { warn "Couldn't create $(dirname "$file"). $manual"; return 0; }
  if py=$(python_bin); then
    ${as_user[@]+"${as_user[@]}"} "$py" - "$file" <<'PY' || warn "Couldn't update $file. $manual"
import json, os, sys
path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
if not isinstance(data, dict):
    sys.exit(3)
data["AutoStart"] = True
tmp = path + ".kiosk-tmp"
try:
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
PY
  elif [ ! -e "$file" ]; then
    printf '{\n  "AutoStart": true\n}\n' | ${as_user[@]+"${as_user[@]}"} tee "$file" >/dev/null \
      || warn "Couldn't create $file. $manual"
  else
    warn "Python 3 isn't available to edit Docker Desktop's settings. $manual"
  fi
  return 0
}

# enable_docker_autostart: Docker starts on its own from now on, and now.
enable_docker_autostart() {
  local user home uid
  if [ "$OS" = Linux ]; then
    systemctl enable --now docker >/dev/null || die "Couldn't start Docker (systemctl enable --now docker)."
    return 0
  fi
  user=$(desktop_user)
  if [ -z "$user" ]; then
    warn "No signed-in user found; open Docker Desktop once yourself."
    return 0
  fi
  home=$(SUDO_USER="$user" home_of_user)
  set_docker_autostart "$home/Library/Group Containers/group.com.docker/settings-store.json" "$user"
  if ! docker_answers; then
    info "Starting Docker Desktop"
    uid=$(id -u "$user")
    launchctl asuser "$uid" sudo -u "$user" open -a Docker \
      || warn "Couldn't start Docker Desktop; open it from Applications."
  fi
}

# wait_for_engine SECONDS: until `docker version` answers.
wait_for_engine() {
  local deadline=$((SECONDS + $1))
  info "Waiting for the Docker engine (up to $(($1 / 60)) minutes)"
  while ! docker_answers; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      if [ "$OS" = Darwin ]; then
        die "Docker didn't start — open Docker Desktop once, accept any prompt, then re-run this command."
      fi
      die "Docker didn't start — check 'systemctl status docker', then re-run this command."
    fi
    sleep "$ENGINE_POLL_S"
  done
}

# check_compose: Docker Compose v2 is there for the docker we run.
check_compose() {
  "${DOCKER[@]}" compose version >/dev/null 2>&1 && return 0
  if [ "$OS" = Darwin ]; then
    die "Docker Compose isn't available to Docker Desktop. Reinstall or update Docker Desktop, then re-run."
  fi
  die "Docker Compose v2 is missing. Install the docker-compose-plugin package, then re-run."
}

# ── Start ─────────────────────────────────────────────────────────────
compose() { "${DOCKER[@]}" compose -f "$KIOSK_DIR/docker-compose.yml" "$@"; }

identity_check() { curl -fsS --max-time 5 "http://127.0.0.1:8090/edge/identity"; }

# update-state.json, shared with update.sh (same keys and format).
UPD_PREVIOUS=''
UPD_REJECTED=''

update_state_value() {  # update_state_value KEY
  local f="$KIOSK_DIR/update-state.json"
  [ -f "$f" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$f" 2>/dev/null | head -n 1
}

read_update_state() {
  UPD_PREVIOUS=$(update_state_value previous_image)
  UPD_REJECTED=$(update_state_value rejected_image)
}

# write_update_state: phase=done, previous_image and rejected_image kept.
# Written in place (not renamed), so on macOS the file stays the desktop
# user's (install_login_items makes it theirs).
write_update_state() {
  { printf '{"previous_image": "%s", "image": "%s", "rejected_image": "%s", "phase": "%s", "updated_at": "%s"}\n' \
      "$UPD_PREVIOUS" "$(image_ref)" "$UPD_REJECTED" "done" \
      "$(date '+%Y-%m-%dT%H:%M:%S%z')" >"$KIOSK_DIR/update-state.json"; } 2>/dev/null \
    || warn "Couldn't write $KIOSK_DIR/update-state.json."
}

# pull_image: compose pull, shown as it runs, with a clear message when the
# channel's image isn't published (or its package isn't public) yet.
pull_image() {
  local out rc=0 hint='try --channel edge, or ask your administrator'
  out=$(mktemp "${TMPDIR:-/tmp}/kiosk-pull.XXXXXX")
  TMP_FILES+=("$out")
  compose pull 2>&1 | tee "$out" || rc=$?
  [ "$rc" != 0 ] || return 0
  [ "$CFG_CHANNEL" != edge ] || hint='ask your administrator'
  if grep -qiE 'manifest unknown|not found|denied|unauthorized' "$out"; then
    die "The $CFG_CHANNEL image isn't published yet, or its package isn't public — $hint."
  fi
  die "Couldn't download the kiosk image. Check the network, then re-run."
}

image_id() { "${DOCKER[@]}" image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

# Docker Desktop's containerd image store can't find an image by its ID once
# it has no name left, even while a container runs it, so the running image
# is named :previous before the pull moves the channel tag, and images are
# put back by name (as update.sh does).

# keep_previous ID REF: tag image ID as :previous, from REF while REF still
# names it (before the pull), else by ID (classic store).
keep_previous() {
  local id="$1" ref="$2"
  if [ "$(image_id "$ref")" = "$id" ]; then
    "${DOCKER[@]}" tag "$ref" "$PREVIOUS_TAG" && return 0
  fi
  "${DOCKER[@]}" tag "$id" "$PREVIOUS_TAG" && return 0
  warn "Couldn't tag the running image $id as $PREVIOUS_TAG (continuing)."
  return 1
}

# retag ID REF: put image ID back on REF, from :previous when it holds that
# image, else by ID (saying why).
retag() {
  local id="$1" ref="$2" kept
  kept=$(image_id "$PREVIOUS_TAG")
  if [ "$kept" = "$id" ]; then
    "${DOCKER[@]}" tag "$PREVIOUS_TAG" "$ref" && return 0
    warn "Couldn't tag $ref from $PREVIOUS_TAG; trying $id by ID."
  elif [ -n "$kept" ]; then
    warn "$PREVIOUS_TAG holds $kept, not $id; tagging $id by ID."
  else
    warn "$PREVIOUS_TAG doesn't exist; tagging $id by ID."
  fi
  "${DOCKER[@]}" tag "$id" "$ref"
}

KIOSK_STATUS=''   # the last health status wait_kiosk_healthy saw

# wait_kiosk_healthy: checked at least once, then every HEALTH_POLL_S until HEALTH_TIMEOUT_S.
wait_kiosk_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while :; do
    KIOSK_STATUS=$("${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' "$KIOSK_CONTAINER" 2>/dev/null || true)
    [ "$KIOSK_STATUS" != healthy ] || return 0
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep "$HEALTH_POLL_S"
  done
}

# start_kiosk: pull, start, wait until healthy, read the identity. Respects
# update-state.json like the nightly update: a version that failed its health
# check here before is not started again, and a new version that doesn't get
# healthy is rolled back.
start_kiosk() {
  local ref prev new kept logs
  ref=$(image_ref)
  logs="See: docker compose -f \"$KIOSK_DIR/docker-compose.yml\" logs edge"
  stop_legacy_kiosk
  prev=$("${DOCKER[@]}" inspect -f '{{.Image}}' "$KIOSK_CONTAINER" 2>/dev/null || true)
  # Before the pull, while the channel tag still names the running image.
  [ -z "$prev" ] || keep_previous "$prev" "$ref" || true
  info "Downloading the kiosk image"
  pull_image
  new=$("${DOCKER[@]}" image inspect -f '{{.Id}}' "$ref" 2>/dev/null || true)
  read_update_state
  if [ -n "$prev" ] && [ -n "$new" ] && [ "$new" != "$prev" ] && [ "$new" = "$UPD_REJECTED" ]; then
    warn "The newest version failed its health check on this laptop before; keeping the current one."
    # The channel tag back on the running image, so compose doesn't recreate it.
    retag "$prev" "$ref" || die "Couldn't keep the current version (docker tag failed)."
    new="$prev"
  elif [ -z "$prev" ] && [ -n "$new" ] && [ "$new" = "$UPD_REJECTED" ]; then
    # No container to keep: like update.sh, the kept :previous image if there is one.
    kept=$(image_id "$PREVIOUS_TAG")
    if [ -n "$kept" ] && [ "$kept" != "$new" ] && "${DOCKER[@]}" tag "$PREVIOUS_TAG" "$ref"; then
      warn "The newest version failed its health check on this laptop before; starting the kept previous version instead."
      new="$kept"
    else
      warn "The newest version failed its health check on this laptop before, and no earlier version is kept, so starting it anyway."
    fi
  fi
  info "Starting the kiosk"
  if ! { compose up -d && wait_kiosk_healthy; }; then
    if [ -n "$prev" ] && [ "$prev" != "$new" ]; then
      warn "The new version didn't become healthy (status: ${KIOSK_STATUS:-unknown}); going back to the previous one."
      [ -z "$new" ] || UPD_REJECTED="$new"   # the nightly update won't try it again
      if retag "$prev" "$ref" && compose up -d && wait_kiosk_healthy; then
        write_update_state
        die "The new kiosk version didn't become healthy, so the installer rolled back to the previous version, which is running. $logs"
      fi
      write_update_state
      die "The new kiosk version didn't become healthy, and the previous version isn't healthy either (status: ${KIOSK_STATUS:-unknown}). $logs"
    fi
    die "The kiosk didn't become healthy in time (status: ${KIOSK_STATUS:-unknown}). $logs"
  fi
  # A re-run ends any update a crash left half done.
  write_update_state
  KIOSK_IDENTITY=$(identity_check 2>/dev/null || true)
  [ -n "$KIOSK_IDENTITY" ] || warn "The kiosk is running but didn't answer $KIOSK_URL/edge/identity yet."
  info "The kiosk is running."
}

# ── Login items ───────────────────────────────────────────────────────
# Linux: a root systemd timer runs update.sh; an autostart entry (and a menu
# entry) runs launch.sh at sign-in. macOS: two launch agents in the desktop
# user's account (the update job runs as that user, like Docker Desktop) and
# a small app in /Applications.
UPDATE_LABEL='com.serversherpa.kiosk.update'
LAUNCH_LABEL='com.serversherpa.kiosk.launch'
UPDATE_UNIT='serversherpa-kiosk-update'
DESKTOP_FILE='serversherpa-kiosk.desktop'
SYSTEMD_UNIT_DIR='/etc/systemd/system'
MAC_APP_DIR='/Applications/ServerSherpa Kiosk.app'

user_home() { SUDO_USER="$1" home_of_user; }

# as_user USER CMD...: run CMD as USER, so the files it makes are theirs.
as_user() {
  local u="$1"
  shift
  if [ "$(id -un)" = "$u" ]; then "$@"; else sudo -u "$u" -H "$@"; fi
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# A path on an Exec=/ExecStart= line: % doubled (systemd), quoted when it has spaces.
exec_path() {
  local p
  p=$(printf '%s' "$1" | sed 's/%/%%/g')
  case "$p" in *[[:space:]]*) printf '"%s"' "$p" ;; *) printf '%s' "$p" ;; esac
}

# render_systemd_units DIR: the nightly update service and its 03:00 timer.
render_systemd_units() {
  local dir="$1"
  cat >"$dir/$UPDATE_UNIT.service" <<EOF
[Unit]
Description=ServerSherpa kiosk nightly update
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
TimeoutStartSec=30min
ExecStart=$(exec_path "$KIOSK_DIR/update.sh")
EOF
  cat >"$dir/$UPDATE_UNIT.timer" <<'EOF'
[Unit]
Description=ServerSherpa kiosk nightly update at 03:00

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  chmod 644 "$dir/$UPDATE_UNIT.service" "$dir/$UPDATE_UNIT.timer"
}

# render_desktop_entry FILE: runs launch.sh (autostart and the app menu).
render_desktop_entry() {
  cat >"$1" <<EOF
[Desktop Entry]
Type=Application
Name=ServerSherpa Kiosk
Comment=Open the ServerSherpa kiosk
Exec=$(exec_path "$KIOSK_DIR/launch.sh")
Terminal=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
EOF
}

# render_launch_agent LABEL FILE calendar|runatload PROGRAM
render_launch_agent() {
  local label="$1" file="$2" mode="$3" program="$4" when
  case "$mode" in
    calendar)  when='  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>' ;;
    runatload) when='  <key>RunAtLoad</key>
  <true/>' ;;
    *) die "render_launch_agent: unknown mode '$mode'" ;;
  esac
  cat >"$file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$(xml_escape "$label")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$program")</string>
  </array>
$when
</dict>
</plist>
EOF
}

# render_app_bundle DIR: a minimal app whose executable runs launch.sh.
render_app_bundle() {
  local dir="$1" exe="$1/Contents/MacOS/ServerSherpa Kiosk"
  case "$KIOSK_DIR" in
    *'"'*|*'$'*|*'`'*|*\\*) die "The install folder can't contain a quote, \$, backquote or backslash: $KIOSK_DIR" ;;
  esac
  mkdir -p "$dir/Contents/MacOS"
  cat >"$dir/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>ServerSherpa Kiosk</string>
  <key>CFBundleDisplayName</key>
  <string>ServerSherpa Kiosk</string>
  <key>CFBundleExecutable</key>
  <string>ServerSherpa Kiosk</string>
  <key>CFBundleIdentifier</key>
  <string>com.serversherpa.kiosk</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
EOF
  printf '#!/bin/sh\nexec "%s/launch.sh"\n' "$KIOSK_DIR" >"$exe"
  chmod 755 "$exe"
  chmod -R a+rX "$dir"
}

# write_as_user USER SRC DEST: copy SRC to DEST as USER (DEST ends up theirs).
write_as_user() {
  as_user "$1" tee "$3" <"$2" >/dev/null
}

install_launch_agent() {  # USER UID LABEL FILE MODE PROGRAM
  local user="$1" uid="$2" label="$3" file="$4" tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/kiosk-agent.XXXXXX")
  TMP_FILES+=("$tmp")
  render_launch_agent "$label" "$tmp" "$5" "$6"
  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  if ! write_as_user "$user" "$tmp" "$file"; then
    warn "Couldn't write $file."
    return 0
  fi
  launchctl bootstrap "gui/$uid" "$file" \
    || warn "Couldn't load $label now; it loads the next time $user signs in."
}

install_login_items_macos() {
  local user uid home agents f
  user=$(desktop_user)
  if [ -z "$user" ]; then
    warn "No signed-in user found, so the nightly update and the kiosk opening at sign-in weren't set up. Re-run the installer from your own account."
    return 0
  fi
  uid=$(id -u "$user")
  home=$(user_home "$user")
  # The update job runs as $user, so its log and state files are theirs.
  for f in update.log update-state.json; do
    [ -e "$KIOSK_DIR/$f" ] || : >"$KIOSK_DIR/$f"
    chown "$user" "$KIOSK_DIR/$f" || warn "Couldn't make $user the owner of $KIOSK_DIR/$f."
    chmod 644 "$KIOSK_DIR/$f"
  done
  agents="$home/Library/LaunchAgents"
  as_user "$user" mkdir -p "$agents" || warn "Couldn't create $agents."
  install_launch_agent "$user" "$uid" "$UPDATE_LABEL" "$agents/$UPDATE_LABEL.plist" calendar "$KIOSK_DIR/update.sh"
  install_launch_agent "$user" "$uid" "$LAUNCH_LABEL" "$agents/$LAUNCH_LABEL.plist" runatload "$KIOSK_DIR/launch.sh"
  render_app_bundle "$MAC_APP_DIR"
  info "Nightly update scheduled (03:00); the kiosk opens when $user signs in, or from Applications › ServerSherpa Kiosk."
}

install_login_items_linux() {
  local user home d tmp
  render_systemd_units "$SYSTEMD_UNIT_DIR"
  if systemctl daemon-reload && systemctl enable --now "$UPDATE_UNIT.timer"; then
    info "Nightly update scheduled (03:00, $UPDATE_UNIT.timer)."
  else
    warn "Couldn't schedule the nightly update; check: systemctl status $UPDATE_UNIT.timer"
  fi
  user=$(desktop_user)
  if [ -z "$user" ]; then
    warn "No desktop user found (run the installer with sudo from your own account), so the kiosk won't open at sign-in. Run $KIOSK_DIR/launch.sh to open it."
    return 0
  fi
  home=$(user_home "$user")
  tmp=$(mktemp "${TMPDIR:-/tmp}/kiosk-desktop.XXXXXX")
  TMP_FILES+=("$tmp")
  render_desktop_entry "$tmp"
  for d in "$home/.config/autostart" "$home/.local/share/applications"; do
    if ! { as_user "$user" mkdir -p "$d" && write_as_user "$user" "$tmp" "$d/$DESKTOP_FILE"; }; then
      warn "Couldn't write $d/$DESKTOP_FILE."
    fi
  done
  info "The kiosk opens when $user signs in, or from the app menu (ServerSherpa Kiosk)."
}

# install_login_items: copy update.sh/launch.sh in, then schedule them.
install_login_items() {
  local f
  for f in update.sh launch.sh; do
    fetch_companion "$f" "$KIOSK_DIR/$f"
    chmod 755 "$KIOSK_DIR/$f"
  done
  if [ "$OS" = Darwin ]; then install_login_items_macos; else install_login_items_linux; fi
}

# remove_login_items: undo install_login_items; anything missing is skipped.
remove_login_items() {
  local user home uid label
  user=$(desktop_user)
  if [ "$OS" = Darwin ]; then
    if [ -n "$user" ]; then
      uid=$(id -u "$user" 2>/dev/null || true)
      home=$(user_home "$user")
      for label in "$UPDATE_LABEL" "$LAUNCH_LABEL"; do
        [ -z "$uid" ] || launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
        rm -f "$home/Library/LaunchAgents/$label.plist"
      done
    else
      warn "No signed-in user found; remove ~/Library/LaunchAgents/$UPDATE_LABEL.plist and $LAUNCH_LABEL.plist from that account yourself."
    fi
    case "$MAC_APP_DIR" in
      /*.app) rm -rf "${MAC_APP_DIR:?}" ;;
    esac
  else
    systemctl disable --now "$UPDATE_UNIT.timer" >/dev/null 2>&1 || true
    systemctl stop "$UPDATE_UNIT.service" >/dev/null 2>&1 || true   # a run in progress
    rm -f "$SYSTEMD_UNIT_DIR/$UPDATE_UNIT.service" "$SYSTEMD_UNIT_DIR/$UPDATE_UNIT.timer"
    systemctl daemon-reload >/dev/null 2>&1 || true
    if [ -n "$user" ]; then
      home=$(user_home "$user")
      rm -f "$home/.config/autostart/$DESKTOP_FILE" "$home/.local/share/applications/$DESKTOP_FILE"
    else
      warn "No desktop user found; remove ~/.config/autostart/$DESKTOP_FILE and ~/.local/share/applications/$DESKTOP_FILE from that account yourself."
    fi
  fi
  return 0
}

# ── Summary ───────────────────────────────────────────────────────────
json_field() {  # json_field JSON KEY -> a top-level string value
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

kiosk_version() {
  json_field "$(curl -fsS --max-time 5 http://127.0.0.1:8090/edge/status 2>/dev/null || true)" version
}

summary() {
  local serial name version user
  serial=$(json_field "$KIOSK_IDENTITY" serial)
  name=$(json_field "$KIOSK_IDENTITY" name)
  version=$(kiosk_version || true)
  echo
  info "The ServerSherpa kiosk is installed."
  echo "  Serial:   ${serial:-unknown}"
  echo "  Name:     ${name:-unknown}"
  echo "  Open:     $KIOSK_URL"
  echo "  Channel:  $CFG_CHANNEL (version ${version:-unknown}); updates nightly at 03:00"
  echo "  Log:      $KIOSK_DIR/install.log"
  if [ "$OS" = Darwin ]; then
    user=$(desktop_user)
    [ -z "$user" ] || echo "  Set up for: $user (the kiosk opens when this account signs in)"
  fi
  echo
  echo "Next: sign in online on the kiosk, then open Kiosk Setup."
  if [ "$OS" = Darwin ]; then
    echo "The kiosk opens when someone signs in. For an unattended station, turn on"
    echo "System Settings › Users & Groups › Automatically log in as."
  fi
  if [ "$ADDED_DOCKER_GROUP" = 1 ]; then
    echo "You were added to the docker group: sign out and back in to use docker without sudo."
  fi
  [ -n "$BROWSER_BIN" ] || echo "Install Google Chrome so the kiosk opens at sign-in: https://www.google.com/chrome/"
  return 0
}

# ── Uninstall ─────────────────────────────────────────────────────────
# check_rm_target LABEL PATH: refuse paths it would be dangerous to remove:
# empty, relative, /, fewer than two components, or with . or .. parts.
check_rm_target() {
  local label="$1" p="$2" part n=0 rest
  [ -n "$p" ] || die "$label is empty; refusing to continue."
  case "$p" in /*) ;; *) die "$label must be an absolute path (got '$p'); refusing to continue." ;; esac
  rest="$p"
  while [ -n "$rest" ]; do
    part="${rest%%/*}"
    case "$rest" in */*) rest="${rest#*/}" ;; *) rest='' ;; esac
    case "$part" in
      '') ;;
      .|..) die "$label can't contain . or .. parts ($p); refusing to continue." ;;
      *) n=$((n + 1)) ;;
    esac
  done
  [ "$n" -ge 2 ] || die "$label '$p' is too close to the top of the disk; refusing to continue."
}

# A folder only counts as kiosk data when it is empty or holds kiosk files.
looks_like_kiosk_data() {
  local d="$1"
  [ -z "$(ls -A "$d" 2>/dev/null)" ] || [ -e "$d/identity.json" ] || [ -e "$d/edge.db" ] || [ -e "$d/edge.key" ]
}

confirm_purge() {
  local ans="${KIOSK_CONFIRM_PURGE:-}"
  if [ -z "$ans" ]; then
    interactive || die "Deleting the data folder needs confirmation: run in a terminal, or set KIOSK_CONFIRM_PURGE=DELETE."
    open_tty
    printf 'This deletes %s: the kiosk identity and any scans not yet uploaded.\n' "$KIOSK_DATA_DIR" >&4
    ask ans "Type DELETE to delete it: " || die_eof
    close_tty
  fi
  [ "$ans" = DELETE ] || die "Not confirmed; nothing was removed."
}

# stop_kiosk_for_uninstall: compose down, or stop before any file is removed
# if the container may still be there (it would come back with Docker).
# Without Docker no engine can bring the container back, so there is nothing to stop.
docker_installed() {
  if [ "$OS" = Darwin ]; then
    [ -d "$DOCKER_APP" ]
  else
    command -v "${DOCKER[0]}" >/dev/null 2>&1
  fi
}

stop_kiosk_for_uninstall() {
  if ! docker_installed; then
    warn "Docker isn't installed, so there is no kiosk container to stop; continuing."
    return 0
  fi
  local removed="The nightly update and the launcher were already removed; re-running the installer puts them back."
  compose down >/dev/null 2>&1 && return 0
  if ! docker_answers; then
    if [ "$OS" = Darwin ]; then
      die "Docker isn't running — start Docker Desktop and re-run --uninstall. $removed"
    fi
    die "Docker isn't running — run 'sudo systemctl start docker' and re-run --uninstall. $removed"
  fi
  if "${DOCKER[@]}" inspect "$KIOSK_CONTAINER" >/dev/null 2>&1; then
    die "Couldn't remove the kiosk container $KIOSK_CONTAINER. Check Docker, then re-run --uninstall. $removed"
  fi
  return 0
}

uninstall() {
  local f
  check_rm_target "The install folder (KIOSK_DIR)" "$KIOSK_DIR"
  check_rm_target "The data folder (KIOSK_DATA_DIR)" "$KIOSK_DATA_DIR"
  if [ "$PURGE_DATA" = 1 ] && [ -d "$KIOSK_DATA_DIR" ]; then
    looks_like_kiosk_data "$KIOSK_DATA_DIR" \
      || die "$KIOSK_DATA_DIR doesn't look like kiosk data (no identity.json or edge.db); refusing to delete it."
    confirm_purge
  fi
  info "Removing the ServerSherpa kiosk"
  # The update job first, so it can't restart the container in between.
  remove_login_items
  if [ -f "$KIOSK_DIR/docker-compose.yml" ]; then
    stop_kiosk_for_uninstall
  fi
  for f in docker-compose.yml config.env update.sh launch.sh install-state.json update-state.json; do
    rm -f "${KIOSK_DIR:?}/$f"
  done
  info "Removed the kiosk from $KIOSK_DIR (install.log and update.log were kept). Docker stays installed."
  if [ "$PURGE_DATA" = 1 ]; then
    if [ -d "$KIOSK_DATA_DIR" ]; then
      rm -rf "${KIOSK_DATA_DIR:?}"
      info "Deleted the data folder $KIOSK_DATA_DIR."
    fi
  else
    info "Kept the data folder $KIOSK_DATA_DIR. It holds the kiosk's identity (its serial and key) and any scans not yet uploaded; reinstalling picks it up again. To delete it too: --uninstall --purge-data."
  fi
}

# ── Arguments ─────────────────────────────────────────────────────────
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --api-url)    [ "$#" -ge 2 ] || die "--api-url needs a value."; OPT_API_URL="$2"; shift 2 ;;
      --portal-url) [ "$#" -ge 2 ] || die "--portal-url needs a value."; OPT_PORTAL_URL="$2"; shift 2 ;;
      --channel)    [ "$#" -ge 2 ] || die "--channel needs a value."; OPT_CHANNEL="$2"; shift 2 ;;
      --yes|-y)     KIOSK_NONINTERACTIVE=1; shift ;;
      --uninstall)  DO_UNINSTALL=1; shift ;;
      --purge-data) PURGE_DATA=1; shift ;;
      --start-fresh) START_FRESH=1; shift ;;
      --help|-h)    usage; exit 0 ;;
      *) die "Unknown option '$1'. Try --help." ;;
    esac
  done
}

# start_log ARGS...: append everything from here on to install.log.
start_log() {
  [ -d "$KIOSK_DIR" ] || return 0
  exec > >(tee -a "$KIOSK_DIR/install.log") 2>&1
  echo "---- $(date '+%Y-%m-%d %H:%M:%S') install.sh $* ----"
}

path_owner() {  # path_owner PATH -> user name of the owner
  if [ "$OS" = Darwin ]; then stat -f %Su "$1" 2>/dev/null; else stat -c %U "$1" 2>/dev/null; fi
}

# check_mac_data_parent: /Users/Shared is writable by everyone, so a folder
# there may have been set up by someone else: no symbolic links, and the
# parent (/Users/Shared/ServerSherpaKiosk by default) is made root:wheel 755,
# or must already belong to root or the desktop user.
check_mac_data_parent() {
  local user="$1" parent powner
  parent=$(dirname "$KIOSK_DATA_DIR")
  [ ! -L "$KIOSK_DATA_DIR" ] \
    || die "The data folder $KIOSK_DATA_DIR is a symbolic link; the installer won't use it. Remove the link (or set KIOSK_DATA_DIR to another folder), then re-run."
  [ ! -L "$parent" ] \
    || die "$parent is a symbolic link; the installer won't keep the kiosk's data under it. Remove the link (or set KIOSK_DATA_DIR to another folder), then re-run."
  if [ -e "$parent" ]; then
    powner=$(path_owner "$parent")
    if [ "$powner" != root ] && { [ -z "$user" ] || [ "$powner" != "$user" ]; }; then
      die "$parent belongs to ${powner:-an unknown user}, not to root${user:+ or $user}, so the installer won't keep the kiosk's data there. Move it aside (or set KIOSK_DATA_DIR to another folder), then re-run."
    fi
  else
    mkdir -p "$parent"
    chown root:wheel "$parent" || die "Couldn't make root the owner of $parent."
    chmod 755 "$parent" || die "Couldn't set the permissions of $parent."
  fi
}

# create_data_dir: made once, mode 700, never touched again. Linux: owned by
# root (the engine runs as root). macOS: owned by the Docker Desktop user,
# because Docker Desktop's file sharing reads the folder as that user.
create_data_dir() {
  local owner=0 user=''
  if [ "$OS" = Darwin ]; then
    user=$(desktop_user)
    check_mac_data_parent "$user"
    [ -z "$user" ] || owner="$user"
  fi
  [ ! -d "$KIOSK_DATA_DIR" ] || return 0
  mkdir -p "$KIOSK_DATA_DIR"
  chown "$owner" "$KIOSK_DATA_DIR" || die "Couldn't make $owner the owner of $KIOSK_DATA_DIR."
  chmod 700 "$KIOSK_DATA_DIR" || die "Couldn't set the permissions of $KIOSK_DATA_DIR."
}

main() {
  parse_args "$@"
  detect_os
  default_dirs
  load_config "$KIOSK_DIR/config.env"
  if [ "$DO_UNINSTALL" = 1 ]; then
    ensure_root "$@"
    # Only the data folder from the saved config: a damaged setting elsewhere must not block uninstall.
    KIOSK_DATA_DIR=$(uninstall_data_dir)
    start_log "$@"
    # Without a compose file there is no container to stop (and on macOS no
    # signed-in user needs to be found for docker).
    [ ! -f "$KIOSK_DIR/docker-compose.yml" ] || setup_docker_cli
    uninstall
    return 0
  fi
  preflight "$@"
  mkdir -p "$KIOSK_DIR"
  chmod 755 "$KIOSK_DIR"
  start_log "$@"
  # Settings before Docker, so the person answers before the long steps.
  prompt_settings
  merge_config
  check_api_reachable
  setup_docker_cli
  ensure_docker
  enable_docker_autostart
  wait_for_engine 180
  check_compose
  create_data_dir
  write_config "$KIOSK_DIR/config.env"
  render_compose "$KIOSK_DIR/docker-compose.yml"
  migrate_legacy_data
  start_kiosk
  install_login_items
  summary
}

# Called on the last line so a partially downloaded script runs nothing.
if [ "${KIOSK_INSTALL_LIB:-0}" != "1" ]; then
  main "$@"
fi
