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
TTY_PATH="${KIOSK_TTY:-/dev/tty}"
DOCKER=(docker)
TMP_FILES=()     # temp files to remove on exit (see cleanup)

DEFAULT_API_URL='https://api.serversherpa.com'
LEGACY_PROJECT='serversherpa-kiosk-laptop'

cleanup() {
  local f
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
}

default_dirs() {
  if [ "$OS" = Darwin ]; then
    : "${KIOSK_DIR:=/Library/Application Support/ServerSherpaKiosk}"
    : "${KIOSK_DATA_DIR:=/Library/Application Support/ServerSherpaKiosk/data}"
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

# write_config FILE: the four keys, KEY=value, mode 644 (no secrets in it).
write_config() {
  local file="$1" tmp
  check_config_value "API URL" "$CFG_API_URL"
  check_config_value "Portal URL" "$CFG_PORTAL_URL"
  check_config_value "Channel" "$CFG_CHANNEL"
  check_data_dir "$CFG_DATA_DIR"
  tmp=$(mktemp "$file.XXXXXX")
  TMP_FILES+=("$tmp")
  chmod 644 "$tmp"   # URLs only; the macOS update job runs as the signed-in user
  {
    printf 'EDGE_CLOUD_API_URL=%s\n' "$CFG_API_URL"
    printf 'EDGE_PORTAL_URL=%s\n' "$CFG_PORTAL_URL"
    printf 'KIOSK_CHANNEL=%s\n' "$CFG_CHANNEL"
    printf 'KIOSK_DATA_DIR=%s\n' "$CFG_DATA_DIR"
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

# find_legacy_data: print the phase-1 data folder if it holds identity.json.
find_legacy_data() {
  local dir="${EDGE_DATA_HOST_DIR:-}"
  [ -n "$dir" ] || dir="${HOME_OF_USER:-$(home_of_user)}/ServerSherpaKiosk"
  if [ -f "$dir/identity.json" ]; then printf '%s' "$dir"; fi
}

# migrate_legacy_data: one-time copy into an empty data folder.
migrate_legacy_data() {
  local legacy
  legacy=$(find_legacy_data)
  [ -n "$legacy" ] || return 0
  # Only into a missing or completely empty folder; never overwrite anything.
  if [ -d "$KIOSK_DATA_DIR" ] && [ -n "$(ls -A "$KIOSK_DATA_DIR" 2>/dev/null)" ]; then
    info "Keeping the existing data in $KIOSK_DATA_DIR (earlier kiosk data in $legacy was not copied)."
    return 0
  fi
  info "Found the earlier kiosk data in $legacy; copying it to $KIOSK_DATA_DIR"
  "${DOCKER[@]}" compose -p "$LEGACY_PROJECT" stop >/dev/null 2>&1 || true
  mkdir -p "$KIOSK_DATA_DIR"
  cp -Rp "$legacy"/. "$KIOSK_DATA_DIR"/
  info "The old folder $legacy was left in place; you can delete it once the kiosk works."
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
      --help|-h)    usage; exit 0 ;;
      *) die "Unknown option '$1'. Try --help." ;;
    esac
  done
}

main() {
  detect_os
  default_dirs
  parse_args "$@"
  die "The installer is not finished yet."
}

# Called on the last line so a partially downloaded script runs nothing.
if [ "${KIOSK_INSTALL_LIB:-0}" != "1" ]; then
  main "$@"
fi
