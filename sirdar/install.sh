#!/usr/bin/env bash
# Sirdar installer: downloads, installs and runs Sirdar (Docker + code).
#
#   curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/sirdar/install.sh | bash
#   bash sirdar/install.sh            # from a checkout
#
# Re-running it updates the code and restarts the stack; an existing
# sirdar/.env is never overwritten.
#
# Environment overrides:
#   REPO_URL               git source  (default https://github.com/encondata/BaseCampV3.git)
#   SIRDAR_BRANCH          branch      (default main)
#   SIRDAR_DIR             install dir (default /opt/serversherpa/sirdar on Linux and macOS).
#                          A fresh interactive install asks for it first (Enter = default);
#                          setting SIRDAR_DIR, or running non-interactively, skips the prompt.
#                          It is the sparse-checkout root: the app lives in <dir>/sirdar/
#                          and its settings in <dir>/sirdar/.env.
#   SIRDAR_PORT            host port, used only when creating .env (default 8098)
#   SIRDAR_NONINTERACTIVE  1 = never prompt; generate every secret, print the admin commands
#
# Testing hooks (not for normal use):
#   SIRDAR_TTY             file to read answers from instead of /dev/tty. Prompts
#                          normally go to /dev/tty too (so `curl ... | bash > log`
#                          still shows them); with SIRDAR_TTY set they go to stderr
#                          instead. The file is only ever read, never written.
#   SIRDAR_DEFAULT_DIR     replaces the built-in default directory (so a test can
#                          exercise the "default exists, don't ask" rule without
#                          touching /opt)
#   SIRDAR_STOP_AFTER_DIR=1  exit 0 right after the directory step, before any
#                          prerequisite, download or Docker work
#   SIRDAR_INSTALL_LIB=1   define the functions without running main, so a test
#                          can source this file and call write_env directly
#
#   SIRDAR_TEST_COMPOSE_URL  download the compose plugin from this URL instead of
#                          the GitHub release (the checksum still comes from the
#                          release), so a test can prove a bad download is rejected
#
#   SIRDAR_DOCKER_VERSION  Linux, static install only: Docker Engine version to
#                          install (e.g. 29.8.2; default = newest stable)
#   SIRDAR_FORCE_STATIC=1  Linux, static install only: replace Docker binaries in
#                          /usr/local/bin that this installer didn't put there
#                          (by default they are left alone with a warning)
#
# Supports Linux (Debian/Ubuntu, Fedora/RHEL, openSUSE/SLES, Arch, Alpine,
# Void, Slackware and others via Docker's static binaries; see README.md) and
# macOS (needs Docker Desktop already installed). Written for bash 3.2
# (macOS's bash).

# POSIX guard: must stay above any bash-only syntax.
if [ -z "${BASH_VERSION:-}" ] || case ":${SHELLOPTS:-}:" in *:posix:*) true ;; *) false ;; esac; then
  echo "This installer needs bash. Run it with bash: curl -fsSL https://raw.githubusercontent.com/encondata/BaseCampV3/main/sirdar/install.sh | bash" >&2
  exit 1
fi

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

banner() {
  printf '%s' "$C_BOLD"
  cat <<'EOF'

   ____  _          _
  / ___|(_)_ __ __| | __ _ _ __
  \___ \| | '__/ _` |/ _` | '__|
   ___) | | | | (_| | (_| | |
  |____/|_|_|  \__,_|\__,_|_|      installer

EOF
  printf '%s' "$C_OFF"
}

# ── Globals (set in main) ─────────────────────────────────────────────
OS=''            # Darwin | Linux
DISTRO=''        # Linux: the os-release ID (ubuntu, fedora, slackware...)
FAMILY=''        # Linux: debian | fedora | suse | arch | alpine | void | slackware | other
PKG_MGR=''       # Linux: apt | dnf | yum | zypper | pacman | apk | xbps | emerge | '' (none)
DOCKER_SOURCE='' # Linux: existing | packages | static
DOCKER_LOG=''    # Linux: dockerd's log file when we started it outside systemd
DIR=''
BRANCH=''
REPO=''
TTY_PATH="${SIRDAR_TTY:-/dev/tty}"
DOCKER=(docker)
ADDED_TO_DOCKER_GROUP=0
GIT_SRC_OPTS=()
TMP_FILES=()     # temp files to remove on exit (see cleanup)
TMP_DIRS=()      # temp dirs to remove on exit

cleanup() {
  local f
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do rm -f "$f"; done
  for f in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do rm -rf "$f"; done
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
  [ "${SIRDAR_NONINTERACTIVE:-0}" != 1 ] || return 1
  { : <"$TTY_PATH"; } 2>/dev/null
}

# Answers come from fd 3 and prompts go to fd 4, both opened once on the tty
# (in tests, fd 3 is SIRDAR_TTY and fd 4 is stderr), so stdin and stdout can
# be a curl pipe and a log file while the person still sees the prompts.
open_tty() {
  exec 3<"$TTY_PATH"
  if [ -n "${SIRDAR_TTY:-}" ]; then exec 4>&2; else exec 4>"$TTY_PATH"; fi
}
close_tty() { exec 3<&- 4>&-; }

die_eof() { die "Input ended before the prompts were answered. Run the installer in a terminal, or set SIRDAR_NONINTERACTIVE=1."; }

ask() {  # ask VAR "prompt"         -> visible answer; returns 1 on EOF
  local _a
  printf '%s' "$2" >&4
  IFS= read -r -u 3 _a || return 1
  eval "$1=\$_a"
}

ask_secret() {  # ask_secret VAR "prompt" -> hidden answer, never echoed; 1 on EOF
  local _a
  printf '%s' "$2" >&4
  IFS= read -r -s -u 3 _a || { printf '\n' >&4; return 1; }
  printf '\n' >&4
  eval "$1=\$_a"
}

# URL-safe random string of exactly N characters.
rand_urlsafe() {
  local n="$1" s=''
  while [ "${#s}" -lt "$n" ]; do
    s="$s$(openssl rand -base64 "$n" | tr -d '\n=' | tr '+/' '-_')"
  done
  printf '%s' "${s:0:$n}"
}

# A Fernet key: URL-safe base64 of 32 random bytes (44 chars, ends in '=').
fernet_key() { openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_'; }

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    # Match the port in the output: BusyBox's lsof ignores the filters and
    # lists every open file.
    lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q ":$1 (LISTEN)" && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    [ -n "$(ss -ltnH "sport = :$1" 2>/dev/null)" ] && return 0
  fi
  return 1
}

# Format a value for a compose env file: bare when it is plain, single-quoted
# (literal, no $-interpolation) otherwise. Callers reject ' and newlines.
env_quote() {
  case "$1" in
    *[!A-Za-z0-9_.~+/=:@%?\&,-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Set KEY=VALUE in FILE (replace the first KEY= line, or append). Uses a temp
# file + mv instead of sed -i, which differs between GNU and BSD.
set_env_key() {
  local key="$1" value="$2" file="$3" tmp
  tmp=$(mktemp "$file.XXXXXX")
  TMP_FILES+=("$tmp")
  K="$key" V="$(env_quote "$value")" awk '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    !done && index($0, k "=") == 1 { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

has_bad_chars() {  # single quote or a line break can't go into the env file
  case "$1" in *"'"*|*$'\n'*|*$'\r'*) return 0 ;; esac
  return 1
}

# ── .env creation (first run only) ────────────────────────────────────
# write_env EXAMPLE TARGET: prompt (when interactive) and write TARGET, mode 600.
write_env() {
  local example="$1" target="$2"
  local port cookie source pepper totp jwt dbpw
  local s_port s_cookie s_source s_pepper s_totp s_jwt s_dbpw
  local def_port="${SIRDAR_PORT:-8098}" a yn

  [ -f "$target" ] && die "$target already exists; refusing to overwrite it."
  [ -f "$example" ] || die "Missing $example"

  port="$def_port"; s_port='default'
  [ -n "${SIRDAR_PORT:-}" ] && s_port='from SIRDAR_PORT'
  cookie=''; s_cookie='default (blank: this host only)'
  source=''; s_source='default (blank: import disabled)'
  pepper=''; s_pepper='generated'
  totp='';   s_totp='generated'
  jwt='';    s_jwt='generated'
  dbpw='';   s_dbpw='generated'

  if interactive; then
    open_tty
    echo >&4
    info "First install: a few settings for $target" >&4
    echo "    Press Enter to accept the [default]. Secrets are hidden as you type." >&4
    echo >&4

    # 1. Port
    while :; do
      ask a "1/7  Host port for Sirdar (127.0.0.1 only, behind your reverse proxy) [$def_port]: " || die_eof
      [ -z "$a" ] && a="$def_port"
      case "$a" in ''|*[!0-9]*) echo "     Enter a number from 1024 to 65535." >&4; continue ;; esac
      if [ "${#a}" -gt 5 ] || [ "$a" -lt 1024 ] || [ "$a" -gt 65535 ]; then
        echo "     Enter a number from 1024 to 65535." >&4; continue
      fi
      if port_in_use "$a"; then
        warn "something is already listening on port $a." 2>&4
        ask yn "     Use it anyway? [y/N]: " || die_eof
        case "$yn" in [Yy]*) ;; *) continue ;; esac
      fi
      port="$a"
      if [ "$a" != "$def_port" ]; then s_port='provided'; fi
      break
    done

    # 2. Cookie domain
    while :; do
      ask a "2/7  Cookie domain for the sign-in cookie [blank = this host only]: " || die_eof
      case "$a" in *[[:space:]]*) echo "     No spaces, please." >&4; continue ;; esac
      if has_bad_chars "$a"; then echo "     No quotes, please." >&4; continue; fi
      cookie="$a"
      [ -n "$a" ] && s_cookie='provided'
      break
    done

    # 3. Portal source database
    echo "3/7  Portal database URL for \"Import from portal\" (a read-only role is recommended)." >&4
    while :; do
      ask a "     postgresql+asyncpg://user:pass@host:5432/db [blank = import disabled]: " || die_eof
      if [ -n "$a" ]; then
        case "$a" in
          postgresql+asyncpg://?*) ;;
          *) echo "     It must start with postgresql+asyncpg://" >&4; continue ;;
        esac
        case "$a" in *[[:space:]]*) echo "     No spaces, please." >&4; continue ;; esac
        if has_bad_chars "$a"; then echo "     No quotes, please." >&4; continue; fi
        s_source='provided'
      fi
      source="$a"
      break
    done

    # 4. Password pepper
    echo "4/7  Password pepper. Paste the portal's value to import portal users with their passwords." >&4
    while :; do
      ask_secret a "     SS_PASSWORD_PEPPER [Enter = generate]: " || die_eof
      if [ -n "$a" ] && has_bad_chars "$a"; then echo "     No quotes, please." >&4; continue; fi
      [ -n "$a" ] && { pepper="$a"; s_pepper='provided'; }
      break
    done

    # 5. 2FA encryption key
    echo "5/7  2FA encryption key (a Fernet key). Paste the portal's value to keep imported 2FA working." >&4
    while :; do
      ask_secret a "     SS_TOTP_ENCRYPTION_KEY [Enter = generate]: " || die_eof
      if [ -n "$a" ]; then
        if [ "${#a}" -ne 44 ] || ! printf '%s' "$a" | grep -Eq '^[A-Za-z0-9_-]{43}=$'; then
          echo "     That doesn't look like a Fernet key (44 characters of URL-safe base64 ending in '=')." >&4
          continue
        fi
        totp="$a"; s_totp='provided'
      fi
      break
    done

    # 6. JWT secret
    while :; do
      ask_secret a "6/7  SIRDAR_JWT_SECRET (at least 32 characters) [Enter = generate]: " || die_eof
      if [ -n "$a" ]; then
        if [ "${#a}" -lt 32 ]; then echo "     It must be at least 32 characters." >&4; continue; fi
        if has_bad_chars "$a"; then echo "     No quotes, please." >&4; continue; fi
        jwt="$a"; s_jwt='provided'
      fi
      break
    done

    # 7. Database password
    while :; do
      ask_secret a "7/7  SIRDAR_DB_PASSWORD for Sirdar's own Postgres (16+ characters) [Enter = generate]: " || die_eof
      if [ -n "$a" ]; then
        if [ "${#a}" -lt 16 ]; then echo "     It must be at least 16 characters." >&4; continue; fi
        case "$a" in
          *[!A-Za-z0-9._~-]*) echo "     It goes into a URL: use only letters, digits and . _ ~ -" >&4; continue ;;
        esac
        dbpw="$a"; s_dbpw='provided'
      fi
      break
    done
    close_tty
  else
    case "$port" in ''|*[!0-9]*) die "SIRDAR_PORT must be a number (got '$port')." ;; esac
    if [ "${#port}" -gt 5 ] || [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
      die "SIRDAR_PORT must be from 1024 to 65535 (got $port)."
    fi
    port_in_use "$port" && warn "something is already listening on port $port."
  fi

  [ -n "$pepper" ] || pepper=$(rand_urlsafe 48)
  [ -n "$totp" ]   || totp=$(fernet_key)
  [ -n "$jwt" ]    || jwt=$(rand_urlsafe 64)
  [ -n "$dbpw" ]   || dbpw=$(rand_urlsafe 32)

  # Build the file next to the target, then move it into place.
  local tmp
  tmp=$(mktemp "$target.new.XXXXXX")
  TMP_FILES+=("$tmp")
  chmod 600 "$tmp"
  cat "$example" >"$tmp"
  set_env_key SIRDAR_ENV production "$tmp"
  set_env_key SIRDAR_PORT "$port" "$tmp"
  set_env_key SIRDAR_DB_PASSWORD "$dbpw" "$tmp"
  set_env_key SIRDAR_JWT_SECRET "$jwt" "$tmp"
  set_env_key SIRDAR_SOURCE_DATABASE_URL "$source" "$tmp"
  set_env_key SIRDAR_COOKIE_DOMAIN "$cookie" "$tmp"
  set_env_key SS_PASSWORD_PEPPER "$pepper" "$tmp"
  set_env_key SS_TOTP_ENCRYPTION_KEY "$totp" "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$target"

  echo
  info "Wrote $target (mode 600):"
  printf '    %-28s %s\n' \
    SIRDAR_PORT "$port ($s_port)" \
    SIRDAR_COOKIE_DOMAIN "$s_cookie" \
    SIRDAR_SOURCE_DATABASE_URL "$s_source" \
    SS_PASSWORD_PEPPER "$s_pepper" \
    SS_TOTP_ENCRYPTION_KEY "$s_totp" \
    SIRDAR_JWT_SECRET "$s_jwt" \
    SIRDAR_DB_PASSWORD "$s_dbpw"
  echo

  if [ -n "$source" ] && { [ "$s_pepper" = generated ] || [ "$s_totp" = generated ]; }; then
    warn "you gave a portal database URL but the pepper or 2FA key was generated. Imported portal passwords and 2FA won't verify until SS_PASSWORD_PEPPER and SS_TOTP_ENCRYPTION_KEY match the portal's."
  fi
  if [ "$s_pepper" = generated ] || [ "$s_totp" = generated ]; then
    warn "the password pepper and 2FA key are new. To import portal users later, set them to the portal's values in $target BEFORE creating local admins. Changing the pepper later invalidates local passwords (fix with reset-password)."
  fi
}

# ── Platform detection ────────────────────────────────────────────────
# os_release KEY -> the value from /etc/os-release (empty when unset/absent).
os_release() {
  [ -r /etc/os-release ] || return 0
  # shellcheck disable=SC1091  # runtime file, not a script to lint
  ( . /etc/os-release && eval "printf '%s' \"\${$1:-}\"" )
}

# Sets FAMILY (debian | fedora | suse | arch | alpine | void | slackware | other)
# and DISTRO (the os-release ID, or a best guess without one).
detect_linux_family() {
  local id='' id_like=''
  if [ -r /etc/os-release ]; then
    id=$(os_release ID); id_like=$(os_release ID_LIKE)
  elif [ -f /etc/slackware-version ]; then id=slackware
  elif [ -f /etc/gentoo-release ]; then id=gentoo
  elif [ -f /etc/alpine-release ]; then id=alpine
  fi
  DISTRO="${id:-unknown}"
  # The ID decides first; ID_LIKE only when the ID itself is unknown.
  FAMILY=$(linux_family_of "$id")
  if [ "$FAMILY" = other ] && [ -n "$id_like" ]; then
    local w
    for w in $id_like; do
      FAMILY=$(linux_family_of "$w")
      [ "$FAMILY" = other ] || break
    done
  fi
}

linux_family_of() {
  case "$1" in
    debian|ubuntu|raspbian|linuxmint|pop|elementary|zorin|kali|neon) echo debian ;;
    fedora|rhel|centos|rocky|almalinux|ol|amzn|redhat) echo fedora ;;
    suse|opensuse|opensuse-*|sles|sled|sle-micro) echo suse ;;
    arch|archarm|manjaro|endeavouros|garuda|artix) echo arch ;;
    alpine) echo alpine ;;
    void) echo void ;;
    slackware) echo slackware ;;
    *) echo other ;;
  esac
}

detect_os() {
  OS=$(uname -s)
  case "$OS" in
    Darwin) ;;
    Linux) detect_linux_family ;;
    *) die "Unsupported OS '$OS'. This installer supports Linux and macOS." ;;
  esac
}

# ── Linux: packages ───────────────────────────────────────────────────
# The package manager for this family (empty on Slackware; first one found
# on other systems).
pick_pkg_mgr() {
  case "$FAMILY" in
    debian) PKG_MGR=apt ;;
    fedora) if command -v dnf >/dev/null 2>&1; then PKG_MGR=dnf; else PKG_MGR=yum; fi ;;
    suse) PKG_MGR=zypper ;;
    arch) PKG_MGR=pacman ;;
    alpine) PKG_MGR=apk ;;
    void) PKG_MGR=xbps ;;
    slackware) PKG_MGR='' ;;
    *)
      PKG_MGR=''
      local c
      for c in apt-get dnf yum zypper pacman apk xbps-install emerge; do
        if command -v "$c" >/dev/null 2>&1; then
          case "$c" in apt-get) PKG_MGR=apt ;; xbps-install) PKG_MGR=xbps ;; *) PKG_MGR="$c" ;; esac
          break
        fi
      done
      ;;
  esac
}

pkg_refresh() {
  case "$PKG_MGR" in
    apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get update ;;
    zypper) as_root zypper --non-interactive refresh ;;
    apk) as_root apk update ;;
    xbps) as_root xbps-install -Sy xbps ;;  # xbps refuses other updates while it is outdated
    *) : ;;  # dnf/yum/pacman/emerge refresh as part of install
  esac
}

pkg_install() {
  case "$PKG_MGR" in
    apt) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    dnf) as_root dnf -y install "$@" ;;
    yum) as_root yum -y install "$@" ;;
    zypper) as_root zypper --non-interactive install "$@" ;;
    pacman) as_root pacman -Syu --noconfirm --needed "$@" ;;  # Arch supports full upgrades only
    apk) as_root apk add "$@" ;;
    xbps) as_root xbps-install -Sy "$@" ;;
    emerge)
      local p q=()
      for p in "$@"; do
        case "$p" in
          git) q+=(dev-vcs/git) ;; curl) q+=(net-misc/curl) ;;
          openssl) q+=(dev-libs/openssl) ;; ca-certificates) q+=(app-misc/ca-certificates) ;;
          *) q+=("$p") ;;
        esac
      done
      as_root emerge --noreplace "${q[@]}" ;;
    *) return 1 ;;
  esac
}

have_ca_bundle() {
  local f
  for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt \
           /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem; do
    [ -s "$f" ] && return 0
  done
  return 1
}

# git, curl, openssl and a CA bundle: installed with the family's package
# manager, or listed with instructions where there is none (Slackware).
linux_base_prereqs() {
  local missing=()
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  have_ca_bundle || missing+=(ca-certificates)
  [ "${#missing[@]}" -gt 0 ] || return 0

  if [ "$FAMILY" = slackware ]; then
    die "Missing: ${missing[*]}. A full Slackware install includes them; add them with:
    slackpkg update && slackpkg install ${missing[*]}
  (git and curl also need their libraries, e.g. perl, nghttp2, brotli, libssh2, cyrus-sasl), then re-run."
  fi
  [ -n "$PKG_MGR" ] || die "Missing: ${missing[*]}, and no supported package manager was found. Install them and re-run."
  info "Installing prerequisites: ${missing[*]}"
  pkg_refresh
  pkg_install "${missing[@]}"
}

# sparse-checkout needs git 2.25+ (CentOS 7, for one, ships 1.8).
check_git_version() {
  local v major minor
  v=$(git --version 2>/dev/null); v=${v#git version }
  major=${v%%.*}; minor=${v#*.}; minor=${minor%%.*}
  case "$major$minor" in ''|*[!0-9]*) warn "Couldn't read the git version ('$v'); it needs to be 2.25 or newer."; return 0 ;; esac
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 25 ]; }; then
    die "git $v is too old: Sirdar's download needs git 2.25 or newer (sparse-checkout). Upgrade git (e.g. from your distribution's backports) and re-run."
  fi
}

# ── Linux: Docker from the family's packages ──────────────────────────
# Contract for docker_pkgs_<family>: 0 = installed; 2 = Docker has no repo for
# this release (already explained; the caller uses the static binaries);
# anything else = a real failure, described in DOCKER_PKG_ERR (the caller
# stops). The caller runs them under `||`, so set -e is off inside: every
# step checks its own status.
DOCKER_PKG_ERR=''

url_exists() { curl -fsSL -o /dev/null -I "$1" 2>/dev/null || curl -fsS -o /dev/null -r 0-0 "$1" 2>/dev/null; }

# pkg_step DESC CMD...: run CMD; on failure record DESC and its exit status.
pkg_step() {
  local desc="$1" s=0
  shift
  "$@" || s=$?
  [ "$s" = 0 ] && return 0
  DOCKER_PKG_ERR="$desc failed (exit status $s)"
  return 1
}

# install_root_file SRC DEST MODE: copy as root, atomically (a temp name next
# to DEST, then mv), so DEST is never left half-written.
install_root_file() {
  as_root install -m "$3" "$1" "$2.sirdar-new" && as_root mv -f "$2.sirdar-new" "$2" && return 0
  as_root rm -f "$2.sirdar-new" 2>/dev/null || true
  return 1
}

# Docker's apt repo for Debian, Ubuntu and their derivatives (mapped to the
# upstream release). The source list goes in only after the key is in place,
# and comes out again if the packages don't install.
docker_pkgs_debian() {
  local repo='' codename='' id arch tmp
  local key=/etc/apt/keyrings/docker.asc list=/etc/apt/sources.list.d/docker.list new_key=0 new_list=0
  id=$(os_release ID)
  if [ "$id" = ubuntu ]; then repo=ubuntu; codename=$(os_release VERSION_CODENAME)
  elif [ -n "$(os_release UBUNTU_CODENAME)" ]; then repo=ubuntu; codename=$(os_release UBUNTU_CODENAME)
  elif [ "$id" = debian ]; then repo=debian; codename=$(os_release VERSION_CODENAME)
  elif [ -n "$(os_release DEBIAN_CODENAME)" ]; then repo=debian; codename=$(os_release DEBIAN_CODENAME)
  else repo=debian; codename=$(os_release VERSION_CODENAME)
  fi
  if [ -z "$codename" ] || ! url_exists "https://download.docker.com/linux/$repo/dists/$codename/Release"; then
    warn "Docker's apt repository has no '$repo ${codename:-?}' release; using Docker's static binaries instead."
    return 2
  fi
  info "Adding Docker's official apt repository ($repo $codename)"
  arch=$(dpkg --print-architecture) || { DOCKER_PKG_ERR="dpkg --print-architecture failed"; return 1; }
  new_tmp_dir tmp || return 1
  if ! curl -fsSL --retry 3 -o "$tmp/docker.asc" "https://download.docker.com/linux/$repo/gpg" || [ ! -s "$tmp/docker.asc" ]; then
    DOCKER_PKG_ERR="downloading Docker's signing key from https://download.docker.com/linux/$repo/gpg failed"
    return 1
  fi
  [ -e "$key" ] || new_key=1
  [ -e "$list" ] || new_list=1
  as_root install -m 0755 -d /etc/apt/keyrings || { DOCKER_PKG_ERR="creating /etc/apt/keyrings failed"; return 1; }
  if ! install_root_file "$tmp/docker.asc" "$key" 0644 || ! [ -s "$key" ]; then
    DOCKER_PKG_ERR="writing $key failed"
    [ "$new_key" = 0 ] || as_root rm -f "$key"
    return 1
  fi
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\n' \
    "$arch" "$key" "$repo" "$codename" >"$tmp/docker.list" || { DOCKER_PKG_ERR="writing the apt source file $list failed"; return 1; }
  install_root_file "$tmp/docker.list" "$list" 0644 || { DOCKER_PKG_ERR="writing $list failed"; return 1; }
  if pkg_step "apt-get update" pkg_refresh \
     && pkg_step "apt-get install" pkg_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    return 0
  fi
  # Don't leave a source behind that the next apt-get update trips over.
  if [ "$new_list" = 1 ]; then as_root rm -f "$list"; warn "Removed $list again."; fi
  [ "$new_key" = 0 ] || as_root rm -f "$key"
  return 1
}

# Fedora / RHEL and rebuilds: Docker's repo (fedora, rhel, else centos). The
# repo file goes in only after the key is confirmed, and comes out again if
# the packages don't install. Amazon Linux: the distro's docker package
# (compose/buildx come as plugins).
docker_pkgs_fedora() {
  local id repo ver tmp mgr="$PKG_MGR" file=/etc/yum.repos.d/docker-ce.repo new_file=0
  id=$(os_release ID)
  if [ "$id" = amzn ]; then
    info "Installing Docker from Amazon Linux's packages"
    pkg_step "$mgr install docker" pkg_install docker || return 1
    return 0
  fi
  case "$id" in fedora) repo=fedora ;; rhel) repo=rhel ;; *) repo=centos ;; esac
  ver=$(os_release VERSION_ID)
  [ "$repo" = fedora ] || ver=${ver%%.*}
  if [ -z "$ver" ] || ! url_exists "https://download.docker.com/linux/$repo/$ver/"; then
    warn "Docker's $repo repository has no release $ver yet; using Docker's static binaries instead."
    return 2
  fi
  info "Adding Docker's official $repo repository"
  new_tmp_dir tmp || return 1
  # The repo file names this key (gpgkey=); dnf imports it during the install.
  if ! curl -fsSL --retry 3 -o "$tmp/gpg" "https://download.docker.com/linux/$repo/gpg" || [ ! -s "$tmp/gpg" ]; then
    DOCKER_PKG_ERR="downloading Docker's signing key from https://download.docker.com/linux/$repo/gpg failed"
    return 1
  fi
  if ! curl -fsSL --retry 3 -o "$tmp/docker-ce.repo" "https://download.docker.com/linux/$repo/docker-ce.repo" \
     || ! grep -q '^\[docker-ce-stable\]' "$tmp/docker-ce.repo"; then
    DOCKER_PKG_ERR="downloading https://download.docker.com/linux/$repo/docker-ce.repo failed"
    return 1
  fi
  [ -e "$file" ] || new_file=1
  install_root_file "$tmp/docker-ce.repo" "$file" 0644 || { DOCKER_PKG_ERR="writing $file failed"; return 1; }
  pkg_step "$mgr install" pkg_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    && return 0
  if [ "$new_file" = 1 ]; then as_root rm -f "$file"; warn "Removed $file again."; fi
  return 1
}

docker_pkgs_suse() {
  pkg_step "zypper refresh" pkg_refresh || return 1
  pkg_step "zypper install" pkg_install docker docker-compose
}
docker_pkgs_arch() { pkg_step "pacman -Syu" pkg_install docker docker-compose; }
docker_pkgs_alpine() {
  pkg_step "apk update" pkg_refresh || return 1
  pkg_step "apk add" pkg_install docker docker-cli-compose
}
docker_pkgs_void() {
  pkg_step "xbps-install -Sy xbps" pkg_refresh || return 1
  pkg_step "xbps-install" pkg_install docker docker-compose
}

# The family's package for a CLI plugin (compose | buildx); empty = none.
plugin_pkg() {
  case "$FAMILY:$1" in
    debian:*) [ -f /etc/apt/sources.list.d/docker.list ] && echo "docker-$1-plugin" ;;
    fedora:*) [ -f /etc/yum.repos.d/docker-ce.repo ] && echo "docker-$1-plugin" ;;
    suse:*|arch:*|void:*) echo "docker-$1" ;;
    alpine:*) echo "docker-cli-$1" ;;
  esac
  return 0
}

# ── Linux: Docker's static binaries ───────────────────────────────────
STATIC_ARCH=''   # x86_64 | aarch64
static_arch() {
  case "$(uname -m)" in
    x86_64|amd64) STATIC_ARCH=x86_64 ;;
    aarch64|arm64) STATIC_ARCH=aarch64 ;;
    *) die "Docker's static binaries cover x86_64 and aarch64 only (this machine is $(uname -m)). Install Docker Engine and the compose plugin yourself, then re-run." ;;
  esac
}

new_tmp_dir() {  # new_tmp_dir VAR -> a temp dir removed on exit
  local d
  d=$(mktemp -d "${TMPDIR:-/tmp}/sirdar.XXXXXX")
  TMP_DIRS+=("$d")
  eval "$1=\$d"
}

# True when FILE starts with the ELF magic (\x7fELF): an executable, not an
# HTML error page or a truncated download.
is_elf() { [ "$(head -c 4 "$1" 2>/dev/null)" = "$(printf '\177ELF')" ]; }

sha256_of() {  # sha256_of FILE -> lowercase hex digest
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"
  else openssl dgst -sha256 -r "$1"
  fi | awk '{print $1}'
}

is_sha256() { case "$1" in *[!0-9a-f]*|'') return 1 ;; esac; [ "${#1}" -eq 64 ]; }

# What the static install put in /usr/local/bin: line 1 = the Docker version,
# then one binary name per line. A binary not listed here isn't ours.
STATIC_MARKER=/usr/local/lib/sirdar-installer/static-docker-version
static_ours() { [ -f "$STATIC_MARKER" ] && tail -n +2 "$STATIC_MARKER" | grep -qxF "$1"; }

# Docker Engine (dockerd, containerd, runc, docker CLI...) into /usr/local/bin.
# A binary already there that this installer didn't put there is left alone
# (with a warning) unless SIRDAR_FORCE_STATIC=1.
install_docker_static() {
  static_arch
  local base="https://download.docker.com/linux/static/stable/$STATIC_ARCH" ver tmp tgz
  ver="${SIRDAR_DOCKER_VERSION:-}"
  if [ -z "$ver" ]; then
    ver=$(curl -fsSL "$base/" | grep -oE 'docker-[0-9]+\.[0-9]+\.[0-9]+\.tgz' \
            | sed -e 's/^docker-//' -e 's/\.tgz$//' | sort -u -t. -k1,1n -k2,2n -k3,3n | tail -n 1) || true
    [ -n "$ver" ] || die "Couldn't list Docker's static releases at $base/."
  fi
  info "Installing Docker $ver from Docker's static binaries ($STATIC_ARCH) into /usr/local/bin"
  new_tmp_dir tmp
  tgz="$tmp/docker.tgz"
  curl -fL --retry 3 -o "$tgz" "$base/docker-$ver.tgz" \
    || { rm -f "$tgz"; die "Couldn't download $base/docker-$ver.tgz"; }
  # Docker publishes no checksum for these: at least the archive must list.
  if [ ! -s "$tgz" ] || ! tar -tzf "$tgz" >/dev/null 2>&1; then
    rm -f "$tgz"
    die "The download of docker-$ver.tgz is empty or not a valid archive; removed it. Re-run the installer."
  fi
  tar -xzf "$tgz" -C "$tmp" || { rm -rf "$tmp/docker" "$tgz"; die "docker-$ver.tgz didn't extract."; }
  rm -f "$tgz"
  local b n installed=() skipped=()
  for n in dockerd docker; do
    is_elf "$tmp/docker/$n" || die "docker-$ver.tgz doesn't contain a usable $n."
  done
  # A foreign core binary would leave a half-Docker that fails later at the
  # daemon wait, so stop before installing anything.
  if [ "${SIRDAR_FORCE_STATIC:-0}" != 1 ]; then
    local blocked=()
    for n in docker dockerd containerd runc; do
      if [ -e "$tmp/docker/$n" ] && [ -e "/usr/local/bin/$n" ] && ! static_ours "$n"; then
        blocked+=("/usr/local/bin/$n")
      fi
    done
    if [ "${#blocked[@]}" -gt 0 ]; then
      rm -rf "$tmp/docker"
      die "Can't install Docker $ver's binaries: ${blocked[*]} already exist and weren't put there by this installer, so Docker would be half-installed. Nothing was changed. To replace them with Docker $ver's, re-run with SIRDAR_FORCE_STATIC=1 (it overwrites those files); otherwise remove or rename them yourself."
    fi
  fi
  as_root mkdir -p /usr/local/bin
  for b in "$tmp"/docker/*; do
    n=${b##*/}
    if [ -e "/usr/local/bin/$n" ] && ! static_ours "$n" && [ "${SIRDAR_FORCE_STATIC:-0}" != 1 ]; then
      skipped+=("$n"); continue
    fi
    install_root_file "$b" "/usr/local/bin/$n" 0755 || die "Couldn't install /usr/local/bin/$n."
    installed+=("$n")
  done
  if [ "${#skipped[@]}" -gt 0 ]; then
    warn "These are already in /usr/local/bin and weren't put there by this installer, so they were left alone: ${skipped[*]}. To replace them with Docker $ver's, re-run with SIRDAR_FORCE_STATIC=1."
  fi
  if [ "${#installed[@]}" -gt 0 ]; then
    { echo "$ver"
      { [ -f "$STATIC_MARKER" ] && tail -n +2 "$STATIC_MARKER"; printf '%s\n' "${installed[@]}"; } | sort -u
    } >"$tmp/marker"
    as_root mkdir -p "${STATIC_MARKER%/*}"
    write_root_file "$STATIC_MARKER" 0644 <"$tmp/marker"
  fi
  hash -r
  DOCKER_SOURCE=static
}

CLI_PLUGINS=/usr/local/lib/docker/cli-plugins

# The tag of a GitHub repo's latest release, from /releases/latest's redirect
# (no API call, so no rate limit).
github_latest_tag() {
  local tag
  tag=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$1/releases/latest") || true
  tag=${tag##*/}
  case "$tag" in v[0-9]*) printf '%s' "$tag" ;; *) die "Couldn't find the latest $1 release (got '$tag')." ;; esac
}

# install_cli_plugin NAME URL SHA256: download, check it is an ELF binary with
# the published checksum, then install it. A bad download is deleted.
install_cli_plugin() {
  local tmp f got
  new_tmp_dir tmp
  f="$tmp/$1"
  curl -fL --retry 3 -o "$f" "$2" || { rm -f "$f"; die "Couldn't download $2"; }
  if [ ! -s "$f" ] || ! is_elf "$f"; then
    rm -f "$f"
    die "The download of $2 isn't a Linux executable (corrupted, or an error page); removed it. Re-run the installer."
  fi
  got=$(sha256_of "$f")
  if [ "$got" != "$3" ]; then
    rm -f "$f"
    die "Checksum mismatch for $2 (expected $3, got ${got:-nothing}); removed the download. Re-run the installer."
  fi
  as_root mkdir -p "$CLI_PLUGINS"
  install_root_file "$f" "$CLI_PLUGINS/$1" 0755 || die "Couldn't install $CLI_PLUGINS/$1."
}

# docker compose v2: the family's package when Docker came from packages,
# else (or if that didn't work) the latest static plugin from GitHub,
# checked against the release's <asset>.sha256.
ensure_compose_plugin() {
  docker compose version >/dev/null 2>&1 && return 0
  local pkg tag asset rel sha
  pkg=$(plugin_pkg compose)
  if [ "$DOCKER_SOURCE" != static ] && [ -n "$pkg" ] && [ -n "$PKG_MGR" ]; then
    info "Installing the Docker Compose plugin ($pkg)"
    pkg_install "$pkg" || true
    docker compose version >/dev/null 2>&1 && return 0
  fi
  static_arch
  tag=$(github_latest_tag docker/compose) || exit 1
  asset="docker-compose-linux-$STATIC_ARCH"
  rel="https://github.com/docker/compose/releases/download/$tag"
  sha=$(curl -fsSL --retry 3 "$rel/$asset.sha256" | awk '{print $1}') || true
  is_sha256 "$sha" || die "Couldn't read the checksum $rel/$asset.sha256."
  info "Installing the Docker Compose plugin ($tag from GitHub)"
  install_cli_plugin docker-compose "${SIRDAR_TEST_COMPOSE_URL:-$rel/$asset}" "$sha"
  docker compose version >/dev/null 2>&1 \
    || die "'docker compose' still doesn't work. Install Docker's compose plugin (https://docs.docker.com/compose/install/linux/) and re-run."
}

# buildx: compose builds with BuildKit and needs it for --build. The GitHub
# binary is checked against the release's checksums.txt.
ensure_buildx_plugin() {
  docker buildx version >/dev/null 2>&1 && return 0
  local pkg tag arch asset rel sha
  pkg=$(plugin_pkg buildx)
  if [ "$DOCKER_SOURCE" != static ] && [ -n "$pkg" ] && [ -n "$PKG_MGR" ]; then
    info "Installing the Docker buildx plugin ($pkg)"
    pkg_install "$pkg" || true
    docker buildx version >/dev/null 2>&1 && return 0
  fi
  static_arch
  tag=$(github_latest_tag docker/buildx) || exit 1
  case "$STATIC_ARCH" in x86_64) arch=amd64 ;; *) arch=arm64 ;; esac
  asset="buildx-$tag.linux-$arch"
  rel="https://github.com/docker/buildx/releases/download/$tag"
  # Lines look like "<sha256> *buildx-v0.37.2.linux-arm64".
  sha=$(curl -fsSL --retry 3 "$rel/checksums.txt" \
          | awk -v a="$asset" '{ n = $2; sub(/^\*/, "", n) } n == a { print $1; exit }') || true
  is_sha256 "$sha" || die "Couldn't find $asset in $rel/checksums.txt."
  info "Installing the Docker buildx plugin ($tag from GitHub)"
  install_cli_plugin docker-buildx "$rel/$asset" "$sha"
  docker buildx version >/dev/null 2>&1 || die "'docker buildx' still doesn't work after installing $tag."
}

# ── Linux: the Docker daemon ──────────────────────────────────────────
docker_bin() { command -v docker 2>/dev/null || echo docker; }
docker_reachable() { docker info >/dev/null 2>&1 || as_root "$(docker_bin)" info >/dev/null 2>&1; }

ensure_docker_group() {
  if command -v getent >/dev/null 2>&1; then
    getent group docker >/dev/null 2>&1 && return 0
  else
    grep -q '^docker:' /etc/group 2>/dev/null && return 0
  fi
  info "Creating the docker group"
  if command -v groupadd >/dev/null 2>&1; then as_root groupadd docker
  else as_root addgroup docker
  fi
}

add_user_to_docker_group() {
  local me="$1"
  if command -v usermod >/dev/null 2>&1; then as_root usermod -aG docker "$me"
  elif command -v gpasswd >/dev/null 2>&1; then as_root gpasswd -a "$me" docker
  else as_root addgroup "$me" docker
  fi
}

SIRDAR_MARK='# Added by the Sirdar installer'

# Make sure dockerd has cgroups to work with (Slackware mounts v1 in rc.S).
ensure_cgroups() {
  [ -n "$(ls -A /sys/fs/cgroup 2>/dev/null)" ] && return 0
  as_root mkdir -p /sys/fs/cgroup
  as_root mount -t cgroup2 none /sys/fs/cgroup \
    || warn "/sys/fs/cgroup is empty and mounting cgroup2 there failed; dockerd may not start."
}

# write_root_file PATH MODE (content on stdin): written atomically as root.
write_root_file() {
  local tmp
  new_tmp_dir tmp
  cat >"$tmp/f"
  install_root_file "$tmp/f" "$1" "$2" || die "Couldn't write $1."
}

# Append a marker-guarded block to a Slackware rc script. A missing script is
# created (executable); an existing one keeps its mode: Slackware runs only
# executable rc scripts, so a non-executable one gets a warning instead.
hook_rc_file() {  # hook_rc_file FILE ACTION
  local f="$1" act="$2"
  if [ ! -f "$f" ]; then
    printf '#!/bin/sh\n' | write_root_file "$f" 0755
  elif [ ! -x "$f" ]; then
    warn "$f isn't executable, so Slackware won't run it (or the rc.docker $act in it). To enable it: chmod +x $f"
  fi
  grep -qF "$SIRDAR_MARK (docker)" "$f" && return 0
  printf '\n%s (docker)\nif [ -x /etc/rc.d/rc.docker ]; then\n  /etc/rc.d/rc.docker %s\nfi\n' "$SIRDAR_MARK" "$act" \
    | as_root tee -a "$f" >/dev/null
}

slackware_rc_docker() {
  local rc=/etc/rc.d/rc.docker dockerd start=(/etc/rc.d/rc.docker start)
  dockerd=$(command -v dockerd 2>/dev/null || echo /usr/local/bin/dockerd)
  if [ -f "$rc" ] && ! grep -qF "$SIRDAR_MARK" "$rc"; then
    # Someone else's rc.docker (e.g. from SlackBuilds): never edited or chmodded.
    info "Using the existing $rc (not written by this installer; left unchanged)"
    if [ ! -x "$rc" ]; then
      warn "$rc isn't executable, which Slackware treats as disabled: it won't start at boot. Starting it with sh for this run only."
      start=(sh "$rc" start)
    fi
    if ! grep -qs 'rc\.docker' /etc/rc.d/rc.local; then
      warn "/etc/rc.d/rc.local doesn't run rc.docker, so starting Docker at boot is up to you: chmod +x $rc and add it to /etc/rc.d/rc.local."
    fi
  else
    info "Writing $rc and hooking it into rc.local / rc.local_shutdown"
    as_root mkdir -p /etc/rc.d
    write_root_file "$rc" 0755 <<EOF
#!/bin/sh
$SIRDAR_MARK: start/stop the Docker daemon (Docker's static binaries).
# Usage: /etc/rc.d/rc.docker start|stop|restart|status

DOCKERD=$dockerd
PIDFILE=/var/run/docker.pid
LOGFILE=/var/log/docker.log

running() {
  [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null
}

docker_start() {
  if running; then echo "dockerd is already running."; return 0; fi
  # dockerd needs cgroups; mount cgroup2 when nothing is mounted yet.
  if [ -z "\$(ls -A /sys/fs/cgroup 2>/dev/null)" ]; then
    mkdir -p /sys/fs/cgroup
    mount -t cgroup2 none /sys/fs/cgroup || echo "rc.docker: couldn't mount cgroup2 on /sys/fs/cgroup" >&2
  fi
  echo "Starting dockerd:  \$DOCKERD"
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
    nohup "\$DOCKERD" --pidfile "\$PIDFILE" </dev/null >>"\$LOGFILE" 2>&1 &
}

docker_stop() {
  if ! running; then echo "dockerd is not running."; rm -f "\$PIDFILE"; return 0; fi
  echo "Stopping dockerd."
  kill "\$(cat "\$PIDFILE")"
  i=0
  while running && [ "\$i" -lt 30 ]; do sleep 1; i=\$((i + 1)); done
  running && echo "dockerd didn't stop within 30 s." >&2
  return 0
}

case "\$1" in
  start) docker_start ;;
  stop) docker_stop ;;
  restart) docker_stop; sleep 1; docker_start ;;
  status) if running; then echo "dockerd is running (pid \$(cat "\$PIDFILE"))."; else echo "dockerd is stopped."; exit 1; fi ;;
  *) echo "usage: \$0 start|stop|restart|status"; exit 1 ;;
esac
EOF
    hook_rc_file /etc/rc.d/rc.local start
    hook_rc_file /etc/rc.d/rc.local_shutdown stop
  fi
  ensure_cgroups
  as_root "${start[@]}"
  DOCKER_LOG=/var/log/docker.log
}

systemd_docker() {
  if ! systemctl cat docker.service >/dev/null 2>&1; then
    info "Writing /etc/systemd/system/docker.service"
    write_root_file /etc/systemd/system/docker.service 0644 <<EOF
$SIRDAR_MARK: Docker's static binaries.
[Unit]
Description=Docker Application Container Engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v dockerd 2>/dev/null || echo /usr/local/bin/dockerd)
ExecReload=/bin/kill -s HUP \$MAINPID
Restart=always
RestartSec=2
LimitNOFILE=infinity
Delegate=yes
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
    as_root systemctl daemon-reload
  fi
  info "Starting the Docker daemon (systemctl enable --now docker)"
  as_root systemctl enable --now docker || true
}

openrc_docker() {
  if [ ! -f /etc/init.d/docker ]; then
    local cg=''
    # Alpine and Gentoo mount cgroups with their own service; wait for it.
    rc-service -e cgroups 2>/dev/null && cg=' need cgroups;'
    info "Writing /etc/init.d/docker"
    write_root_file /etc/init.d/docker 0755 <<EOF
#!/sbin/openrc-run
$SIRDAR_MARK: Docker's static binaries.
command=$(command -v dockerd 2>/dev/null || echo /usr/local/bin/dockerd)
command_background=yes
pidfile=/run/docker.pid
output_log=/var/log/docker.log
error_log=/var/log/docker.log
depend() { need net;$cg after firewall; }
EOF
  fi
  info "Starting the Docker daemon (OpenRC)"
  as_root rc-update add docker default || true
  as_root rc-service docker start || true
  DOCKER_LOG=/var/log/docker.log
}

# Start dockerd now and at boot, the way this system's init does it.
start_docker_daemon() {
  DOCKER_LOG=''
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    systemd_docker
  elif [ "$FAMILY" = slackware ] || [ -f /etc/rc.d/rc.M ]; then
    slackware_rc_docker
  elif command -v rc-service >/dev/null 2>&1; then
    openrc_docker
  elif [ -d /etc/sv/docker ] && [ -d /var/service ]; then
    info "Enabling the runit docker service"
    [ -e /var/service/docker ] || as_root ln -s /etc/sv/docker /var/service/
  else
    warn "No supported init system found: starting dockerd in the background. It won't start at boot."
    ensure_cgroups
    as_root sh -c "nohup '$(command -v dockerd 2>/dev/null || echo /usr/local/bin/dockerd)' </dev/null >>/var/log/docker.log 2>&1 &"
    DOCKER_LOG=/var/log/docker.log
  fi

  info "Waiting for the Docker daemon (up to 60 s)"
  local waited=0
  until docker_reachable; do
    if [ "$waited" -ge 60 ]; then
      if [ -n "$DOCKER_LOG" ] && [ -f "$DOCKER_LOG" ]; then
        warn "Last 30 lines of $DOCKER_LOG:"; as_root tail -n 30 "$DOCKER_LOG" >&2 || true
      elif command -v journalctl >/dev/null 2>&1; then
        warn "Last 30 lines of the docker journal:"; as_root journalctl -u docker -n 30 --no-pager >&2 || true
      fi
      die "The Docker daemon didn't come up within 60 s."
    fi
    sleep 2; waited=$((waited + 2))
  done
}

# Docker Engine (CLI + daemon). Nothing is installed or started when
# `docker info` already works (e.g. a mounted socket).
ensure_docker() {
  DOCKER_SOURCE=existing
  if command -v docker >/dev/null 2>&1 && docker --version >/dev/null 2>&1; then
    if docker --version 2>&1 | grep -qi podman; then
      die "'docker' here is Podman's docker shim ($(docker --version 2>&1 | head -n 1)). Sirdar needs Docker Engine with the compose plugin: remove podman-docker, install Docker Engine (https://docs.docker.com/engine/install/), and re-run."
    fi
    docker_reachable && return 0
  else
    case "$FAMILY" in
      debian|fedora|suse|arch|alpine|void)
        info "Installing Docker Engine ($FAMILY packages)"
        local rc=0
        DOCKER_PKG_ERR=''
        "docker_pkgs_$FAMILY" || rc=$?
        if [ "$rc" = 2 ]; then
          # No Docker repo for this release (already explained): static binaries.
          install_docker_static
        elif [ "$rc" != 0 ]; then
          die "Installing Docker from the $FAMILY packages failed: ${DOCKER_PKG_ERR:-exit status $rc}. This is usually temporary: a network problem, or another package job holding the lock (unattended-upgrades or dpkg on Debian/Ubuntu, dnf-automatic or PackageKit on Fedora/RHEL). Wait for it to finish, then re-run the installer. (Docker's static binaries are only used where Docker has no repository for this release.)"
        elif ! command -v docker >/dev/null 2>&1; then
          die "Docker's $FAMILY packages installed, but there is no docker command on PATH. Check the package install, then re-run."
        else
          DOCKER_SOURCE=packages
        fi
        ;;
      *) install_docker_static ;;
    esac
    hash -r
    docker_reachable && return 0
  fi
  ensure_docker_group
  start_docker_daemon
}

linux_prereqs() {
  # Static Docker lands in /usr/local/bin, which minimal root PATHs can lack.
  case ":$PATH:" in *:/usr/local/bin:*) ;; *) PATH="/usr/local/bin:$PATH" ;; esac
  is_root || command -v sudo >/dev/null 2>&1 \
    || die "This installer needs root. Run it as root, or install sudo and re-run."
  pick_pkg_mgr
  linux_base_prereqs
  check_git_version
  ensure_docker

  # Who runs docker this time
  if is_root || docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  else
    # Absolute path: sudo's secure_path often leaves out /usr/local/bin.
    DOCKER=(sudo "$(docker_bin)")
    local me
    me=$(id -un)
    ensure_docker_group
    if ! id -nG "$me" | tr ' ' '\n' | grep -qx docker; then
      info "Adding $me to the docker group (takes effect on your next login)"
      add_user_to_docker_group "$me"
      ADDED_TO_DOCKER_GROUP=1
    fi
  fi

  ensure_compose_plugin
  ensure_buildx_plugin
}

# ── macOS ─────────────────────────────────────────────────────────────
mac_prereqs() {
  command -v git >/dev/null 2>&1 || die "git is missing. Install Xcode Command Line Tools: xcode-select --install"
  command -v openssl >/dev/null 2>&1 || die "openssl is missing."
  command -v docker >/dev/null 2>&1 \
    || die "Docker isn't installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and re-run."
  if ! docker info >/dev/null 2>&1; then
    info "Starting Docker Desktop"
    open -a Docker || die "Couldn't start Docker Desktop. Start it and re-run."
    local waited=0
    while ! docker info >/dev/null 2>&1; do
      [ "$waited" -ge 120 ] && die "Docker Desktop didn't start within 120 s. Start it and re-run."
      sleep 3; waited=$((waited + 3))
    done
  fi
  docker compose version >/dev/null 2>&1 || die "'docker compose' isn't available. Update Docker Desktop and re-run."
  DOCKER=(docker)
}

# ── Download / update ─────────────────────────────────────────────────
ensure_dir() {
  # Owned by the invoking user, so git and the .env are theirs. Works the same
  # on Linux and macOS (numeric ids: no GNU-only chown flags).
  if [ -d "$DIR" ] && [ -w "$DIR" ]; then return 0; fi
  if [ ! -d "$DIR" ] && mkdir -p "$DIR" 2>/dev/null; then return 0; fi
  # Missing ancestors (e.g. /opt/serversherpa) are created and handed to the
  # user too, outermost first.
  local made=() d="$DIR"
  while [ ! -d "$d" ] && [ "$d" != / ]; do made=("$d" ${made[@]+"${made[@]}"}); d=$(dirname "$d"); done
  info "Creating $DIR (needs sudo)"
  as_root mkdir -p "$DIR"
  for d in ${made[@]+"${made[@]}"}; do as_root chown "$(id -u):$(id -g)" "$d"; done
  as_root chown "$(id -u):$(id -g)" "$DIR"
}

fetch_code() {
  # A local clone source (path or file://) is often owned by another user:
  # let git read it without a "dubious ownership" stop.
  case "$REPO" in
    /*|./*|../*|file://*) GIT_SRC_OPTS=(-c "safe.directory=*") ;;
    *) GIT_SRC_OPTS=() ;;
  esac

  if [ -e "$DIR/.git" ]; then
    # Never fetch/checkout/reset in a git repo that isn't a Sirdar install.
    { [ -f "$DIR/sirdar/docker-compose.yml" ] \
        && git -C "$DIR" sparse-checkout list 2>/dev/null | grep -qx 'sirdar'; } \
      || die "$DIR is not a Sirdar install; choose another SIRDAR_DIR."
    info "Updating $DIR to origin/$BRANCH"
    git "${GIT_SRC_OPTS[@]+"${GIT_SRC_OPTS[@]}"}" -C "$DIR" fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
    git -C "$DIR" checkout -f -B "$BRANCH" "refs/remotes/origin/$BRANCH" --
    git -C "$DIR" reset --hard "refs/remotes/origin/$BRANCH"
  else
    if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
      die "$DIR exists and isn't a git checkout. Move it aside or set SIRDAR_DIR."
    fi
    ensure_dir
    info "Downloading Sirdar ($BRANCH) into $DIR"
    git "${GIT_SRC_OPTS[@]+"${GIT_SRC_OPTS[@]}"}" clone --filter=blob:none --no-checkout --branch "$BRANCH" "$REPO" "$DIR"
    git -C "$DIR" sparse-checkout init --cone
    git -C "$DIR" sparse-checkout set sirdar portal/src portal/public
    git -C "$DIR" checkout "$BRANCH" --
  fi
  [ -f "$DIR/sirdar/docker-compose.yml" ] || die "$DIR/sirdar/docker-compose.yml is missing after checkout."
}

# ── Run ───────────────────────────────────────────────────────────────
compose() {
  "${DOCKER[@]}" compose -f "$DIR/sirdar/docker-compose.yml" --env-file "$DIR/sirdar/.env" "$@"
}

start_stack() {
  info "Building and starting Sirdar (the first build takes a few minutes)"
  compose up -d --build

  local cid status waited=0
  cid=$(compose ps -q sirdar)
  [ -n "$cid" ] || die "The sirdar container didn't start. See: ${DOCKER[*]} compose -f $DIR/sirdar/docker-compose.yml logs"
  info "Waiting for Sirdar to become healthy (up to 300 s)"
  while :; do
    status=$("${DOCKER[@]}" inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)
    [ "$status" = healthy ] && break
    if [ "$waited" -ge 300 ]; then
      warn "Sirdar isn't healthy after 300 s (status: $status). Last 50 log lines:"
      compose logs --tail 50 sirdar >&2 || true
      die "Sirdar didn't become healthy."
    fi
    sleep 5; waited=$((waited + 5))
  done
  info "Sirdar is healthy"
}

env_value() {  # env_value KEY -> value from sirdar/.env, quotes stripped
  local v
  v=$(grep -E "^$1=" "$DIR/sirdar/.env" | head -n 1 | cut -d= -f2- || true)
  v=${v#\'}; v=${v%\'}; v=${v#\"}; v=${v%\"}
  printf '%s' "$v"
}

cmd_prefix() {
  local p="docker"
  [ "${DOCKER[0]}" = sudo ] && p="${DOCKER[*]}"
  printf '%s compose -f %s --env-file %s' "$p" "$DIR/sirdar/docker-compose.yml" "$DIR/sirdar/.env"
}

first_admin() {
  local needs
  needs=$(compose exec -T sirdar python -c "import json,urllib.request;print(json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/system/status'))['needs_setup'])" 2>/dev/null || echo unknown)
  info "needs_setup: $needs"
  [ "$needs" = True ] || return 0

  local admin_cmd
  admin_cmd="$(cmd_prefix) exec sirdar sirdar create-admin --email you@example.com --first-name First --last-name Last"
  if ! interactive; then
    echo "    Sirdar has no users yet. Create the first admin with:"
    echo "      $admin_cmd"
    return 0
  fi

  open_tty
  local yn email first last tries=0
  ask yn "Create the first Sirdar admin now? [Y/n]: " || die_eof
  case "$yn" in [Nn]*) close_tty; echo "    Later: $admin_cmd"; return 0 ;; esac
  while [ "$tries" -lt 4 ]; do   # first attempt + 3 retries
    tries=$((tries + 1))
    email=''; first=''; last=''
    while [ -z "$email" ]; do ask email "  Email: " || die_eof; done
    while [ -z "$first" ]; do ask first "  First name: " || die_eof; done
    while [ -z "$last" ];  do ask last  "  Last name: "; done
    # The CLI's own hidden password prompt needs the terminal on both ends
    # (fd 3 is the tty for reading, fd 4 for writing).
    if compose exec sirdar sirdar create-admin --email "$email" --first-name "$first" --last-name "$last" \
         <&3 >&4; then
      info "Admin $email created"
      close_tty
      return 0
    fi
    warn "create-admin failed."
    [ "$tries" -lt 4 ] || break
    ask yn "Try again? [Y/n]: " || die_eof
    case "$yn" in [Nn]*) break ;; esac
  done
  close_tty
  echo "    Create the admin later with:"
  echo "      $admin_cmd"
}

summary() {
  local port p
  port=$(env_value SIRDAR_PORT); port=${port:-8098}
  p=$(cmd_prefix)
  echo
  printf '%sSirdar is running.%s\n\n' "$C_BOLD" "$C_OFF"
  cat <<EOF
  URL:          http://127.0.0.1:$port   (local only)
  Install dir:  $DIR   (override with SIRDAR_DIR)
  Settings:     $DIR/sirdar/.env
  Update:       re-run this script to update

  Logs:            $p logs -f sirdar
  Create admin:    $p exec sirdar sirdar create-admin --email you@example.com --first-name First --last-name Last
  Import users:    $p exec sirdar sirdar import-users
  Reset password:  $p exec sirdar sirdar reset-password --email you@example.com

  Put a TLS reverse proxy in front of http://127.0.0.1:$port and have it
  rate-limit /api/auth/*. Never expose the container port directly.
EOF
  if [ "$ADDED_TO_DOCKER_GROUP" = 1 ]; then
    echo
    echo "  You were added to the docker group: log out and back in to use docker without sudo."
  fi
  echo
}

# Settle $DIR: SIRDAR_DIR wins; else the default when it already exists or we
# can't prompt; else ask (absolute path, leading ~/ expanded, re-ask otherwise).
choose_dir() {
  local default="${SIRDAR_DEFAULT_DIR:-/opt/serversherpa/sirdar}" a
  if [ -n "${SIRDAR_DIR:-}" ]; then DIR="$SIRDAR_DIR"; return 0; fi
  DIR="$default"
  if [ -e "$default" ] || ! interactive; then return 0; fi
  open_tty
  while :; do
    ask a "Install directory [$default]: " || die_eof
    [ -n "$a" ] || a="$default"
    case "$a" in \~/*) a="$HOME/${a#\~/}" ;; esac
    case "$a" in
      /*) DIR="${a%/}"; [ -n "$DIR" ] || DIR=/; break ;;
      *) printf 'Please enter an absolute path (starting with /).\n' >&4 ;;
    esac
  done
  close_tty
}

main() {
  banner
  detect_os
  choose_dir
  REPO="${REPO_URL:-https://github.com/encondata/BaseCampV3.git}"
  BRANCH="${SIRDAR_BRANCH:-main}"

  info "Platform: $OS${DISTRO:+ ($DISTRO, $FAMILY family)}   Installing to: $DIR   Branch: $BRANCH"
  if [ "${SIRDAR_STOP_AFTER_DIR:-0}" = 1 ]; then exit 0; fi
  if [ "$OS" = Darwin ]; then mac_prereqs; else linux_prereqs; fi
  info "Using: ${DOCKER[*]} ($("${DOCKER[@]}" compose version --short 2>/dev/null || echo compose))"

  fetch_code

  if [ -f "$DIR/sirdar/.env" ]; then
    info "Keeping existing $DIR/sirdar/.env"
  else
    write_env "$DIR/sirdar/.env.example" "$DIR/sirdar/.env"
  fi

  start_stack
  first_admin
  summary
}

# Called on the last line so a partially downloaded script runs nothing.
if [ "${SIRDAR_INSTALL_LIB:-0}" != 1 ]; then main "$@"; fi
