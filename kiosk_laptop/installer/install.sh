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
KIOSK_CONTAINER='serversherpa-kiosk-edge-1'   # project "serversherpa-kiosk", service "edge"
KIOSK_URL='http://localhost:8090'

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

# ── Preflight ─────────────────────────────────────────────────────────
# ensure_root ARGS...: re-run this script through sudo (once) unless root.
# Under `curl | bash` there is no script file, so fetch a copy to run.
ensure_root() {
  is_root && return 0
  command -v sudo >/dev/null 2>&1 || die "This installer needs root. Run it as root, or install sudo and re-run."
  local script="${BASH_SOURCE[0]:-}" v rc=0
  local envs=()
  if [ -z "$script" ] || [ ! -f "$script" ]; then
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
docker_answers() { "${DOCKER[@]}" version >/dev/null 2>&1; }

# ensure_docker: install Docker Desktop (macOS) or Docker Engine (Linux) if missing.
ensure_docker() {
  if [ "$OS" = Darwin ]; then
    PATH="$PATH:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin"
    export PATH
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
    "${DOCKER[@]}" compose version >/dev/null 2>&1 \
      || die "Docker Compose v2 is missing. Install the docker-compose-plugin package, then re-run."
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && getent group docker >/dev/null 2>&1; then
      if ! id -nG "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        usermod -aG docker "$SUDO_USER" && ADDED_DOCKER_GROUP=1
      fi
    fi
  fi
}

install_docker_desktop() {
  local user dmg mnt=/Volumes/Docker
  user=$(desktop_user)
  [ -n "$user" ] || die "Run this installer from your own account (with sudo), not as root, so Docker Desktop is set up for you."
  dmg=$(mktemp "${TMPDIR:-/tmp}/Docker.XXXXXX")
  TMP_FILES+=("$dmg")
  info "Downloading Docker Desktop ($ARCH)"
  curl -fL --progress-bar "https://desktop.docker.com/mac/main/$ARCH/Docker.dmg" -o "$dmg" \
    || die "Couldn't download Docker Desktop. Check the network, then re-run."
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$dmg" || die "Couldn't open the Docker Desktop disk image."
  info "Installing Docker Desktop for $user"
  if ! "$mnt/Docker.app/Contents/MacOS/install" --accept-license --user="$user"; then
    hdiutil detach -quiet "$mnt" || true
    die "Docker Desktop didn't install. See the messages above, then re-run."
  fi
  hdiutil detach -quiet "$mnt" || true
}

# Use python3 for JSON, but not macOS's /usr/bin/python3 stub when the
# command line tools are missing (it pops an install dialog instead).
has_python() {
  command -v python3 >/dev/null 2>&1 || return 1
  if [ "$OS" = Darwin ] && [ "$(command -v python3)" = /usr/bin/python3 ]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  return 0
}

DOCKER_DEFAULT_SHARES='"/Users", "/Volumes", "/private", "/tmp", "/var/folders"'

# set_docker_settings FILE SHARE_DIR: AutoStart on and SHARE_DIR shared with
# containers (Docker Desktop doesn't share /Library by default); every other
# key is kept. Without python3 the file is only created when missing, never
# rewritten.
set_docker_settings() {
  local file="$1" share="$2"
  mkdir -p "$(dirname "$file")"
  if has_python; then
    python3 - "$file" "$share" <<'PY' || warn "Couldn't update $file. In Docker Desktop › Settings › General, turn on Start Docker Desktop when you sign in, and under Resources › File sharing add $share."
import json, os, sys
path, share = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
if not isinstance(data, dict):
    sys.exit(3)
data["AutoStart"] = True
dirs = data.get("FilesharingDirectories")
if not isinstance(dirs, list):
    dirs = ["/Users", "/Volumes", "/private", "/tmp", "/var/folders"]
if share and not any(share == d or share.startswith(d.rstrip("/") + "/") for d in dirs):
    dirs.append(share)
data["FilesharingDirectories"] = dirs
tmp = path + ".kiosk-tmp"
with open(tmp, "w") as f:
    json.dump(data, f, indent=2)
os.replace(tmp, path)
PY
  elif [ ! -e "$file" ]; then
    check_data_dir "$share"
    printf '{\n  "AutoStart": true,\n  "FilesharingDirectories": [%s, "%s"]\n}\n' \
      "$DOCKER_DEFAULT_SHARES" "$share" >"$file"
  else
    warn "Python 3 isn't available to edit Docker Desktop's settings. In Docker Desktop › Settings › General, turn on Start Docker Desktop when you sign in, and under Resources › File sharing add $share."
  fi
  return 0
}

# enable_docker_autostart: Docker starts on its own from now on, and now.
enable_docker_autostart() {
  local user home file uid
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
  file="$home/Library/Group Containers/group.com.docker/settings-store.json"
  set_docker_settings "$file" "$KIOSK_DATA_DIR"
  [ ! -e "$file" ] || chown "$user" "$file" || true
  if ! docker_answers; then
    info "Starting Docker Desktop"
    uid=$(id -u "$user")
    launchctl asuser "$uid" sudo -u "$user" open -a Docker \
      || warn "Couldn't start Docker Desktop; open it from Applications."
  fi
}

# wait_for_engine SECONDS: until `docker version` answers.
wait_for_engine() {
  local deadline=$((SECONDS + $1)) home sock
  info "Waiting for the Docker engine (up to $(($1 / 60)) minutes)"
  while ! docker_answers; do
    # Docker Desktop without the default socket: use the user's socket.
    if [ "$OS" = Darwin ] && [ -z "${DOCKER_HOST:-}" ] && [ ! -S /var/run/docker.sock ]; then
      home=$(SUDO_USER="$(desktop_user)" home_of_user)
      sock="$home/.docker/run/docker.sock"
      if [ -S "$sock" ]; then DOCKER_HOST="unix://$sock"; export DOCKER_HOST; continue; fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      if [ "$OS" = Darwin ]; then
        die "Docker didn't start — open Docker Desktop once, accept any prompt, then re-run this command."
      fi
      die "Docker didn't start — check 'systemctl status docker', then re-run this command."
    fi
    sleep "$ENGINE_POLL_S"
  done
}

# ── Start ─────────────────────────────────────────────────────────────
compose() { "${DOCKER[@]}" compose -f "$KIOSK_DIR/docker-compose.yml" "$@"; }

identity_check() { curl -fsS --max-time 5 "http://127.0.0.1:8090/edge/identity"; }

# start_kiosk: pull, start, wait until healthy, read the identity.
start_kiosk() {
  local status='' deadline
  # A phase-1 manual install holds port 8090.
  "${DOCKER[@]}" compose -p "$LEGACY_PROJECT" stop >/dev/null 2>&1 || true
  info "Downloading the kiosk image"
  compose pull || die "Couldn't download the kiosk image. Check the network, then re-run."
  info "Starting the kiosk"
  compose up -d || die "The kiosk didn't start. See the messages above, then re-run."
  deadline=$((SECONDS + HEALTH_TIMEOUT_S))
  while :; do
    status=$("${DOCKER[@]}" inspect -f '{{.State.Health.Status}}' "$KIOSK_CONTAINER" 2>/dev/null || true)
    [ "$status" != healthy ] || break
    [ "$SECONDS" -lt "$deadline" ] \
      || die "The kiosk didn't become healthy in time (status: ${status:-unknown}). See: docker compose -f \"$KIOSK_DIR/docker-compose.yml\" logs edge"
    sleep "$HEALTH_POLL_S"
  done
  KIOSK_IDENTITY=$(identity_check 2>/dev/null || true)
  [ -n "$KIOSK_IDENTITY" ] || warn "The kiosk is running but didn't answer $KIOSK_URL/edge/identity yet."
  info "The kiosk is running."
}

# ── Login items (Task 4 fills these in) ───────────────────────────────
install_login_items() { :; }
remove_login_items() { :; }

# ── Summary ───────────────────────────────────────────────────────────
json_field() {  # json_field JSON KEY -> a top-level string value
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

kiosk_version() {
  json_field "$(curl -fsS --max-time 5 http://127.0.0.1:8090/edge/status 2>/dev/null || true)" version
}

summary() {
  local serial name version
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
  if [ -f "$KIOSK_DIR/docker-compose.yml" ]; then
    compose down >/dev/null 2>&1 || warn "Couldn't stop the kiosk container (is Docker running?)."
  fi
  remove_login_items
  for f in docker-compose.yml config.env update.sh launch.sh install-state.json update-state.json; do
    rm -f "${KIOSK_DIR:?}/$f"
  done
  info "Removed the kiosk from $KIOSK_DIR (install.log was kept). Docker stays installed."
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

# create_data_dir: made once, mode 700, never touched again. Linux: owned by
# root (the engine runs as root). macOS: owned by the Docker Desktop user,
# because Docker Desktop's file sharing reads the folder as that user.
create_data_dir() {
  local owner=0 user
  [ ! -d "$KIOSK_DATA_DIR" ] || return 0
  if [ "$OS" = Darwin ]; then
    user=$(desktop_user)
    [ -z "$user" ] || owner="$user"
  fi
  mkdir -p "$KIOSK_DATA_DIR"
  chown "$owner" "$KIOSK_DATA_DIR"
  chmod 700 "$KIOSK_DATA_DIR"
}

main() {
  parse_args "$@"
  detect_os
  default_dirs
  load_config "$KIOSK_DIR/config.env"
  if [ "$DO_UNINSTALL" = 1 ]; then
    ensure_root "$@"
    merge_config
    start_log "$@"
    uninstall
    return 0
  fi
  preflight "$@"
  mkdir -p "$KIOSK_DIR"
  chmod 755 "$KIOSK_DIR"
  start_log "$@"
  # Settings before Docker: the person answers before the long steps, and the
  # data folder is known when Docker Desktop's file sharing is set.
  prompt_settings
  merge_config
  check_api_reachable
  ensure_docker
  enable_docker_autostart
  wait_for_engine 180
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
