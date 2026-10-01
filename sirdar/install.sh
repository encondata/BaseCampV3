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
#   SIRDAR_DIR             install dir (default /opt/sirdar on Linux, $HOME/sirdar on macOS)
#   SIRDAR_PORT            host port, used only when creating .env (default 8098)
#   SIRDAR_NONINTERACTIVE  1 = never prompt; generate every secret, print the admin commands
#
# Testing hooks (not for normal use):
#   SIRDAR_TTY             file to read answers from instead of /dev/tty
#   SIRDAR_INSTALL_LIB=1   define the functions without running main, so a test
#                          can source this file and call write_env directly
#
# Supports Ubuntu/Debian (installs missing prerequisites) and macOS (needs
# Docker Desktop already installed). Written for bash 3.2 (macOS's bash).
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
DISTRO=''        # ubuntu | debian (Linux only)
DIR=''
BRANCH=''
REPO=''
TTY_PATH="${SIRDAR_TTY:-/dev/tty}"
DOCKER=(docker)
ADDED_TO_DOCKER_GROUP=0
GIT_SRC_OPTS=()

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

# Answers come from fd 3, opened once on the tty (or SIRDAR_TTY in tests),
# so stdin can stay a curl pipe and a file-backed test reads sequentially.
open_tty() { exec 3<"$TTY_PATH"; }

ask() {  # ask VAR "prompt"         -> visible answer
  local _a
  printf '%s' "$2"
  IFS= read -r -u 3 _a || _a=''
  eval "$1=\$_a"
}

ask_secret() {  # ask_secret VAR "prompt" -> hidden answer, never echoed
  local _a
  printf '%s' "$2"
  IFS= read -r -s -u 3 _a || _a=''
  printf '\n'
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
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
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
  cookie=''; s_cookie='default (blank: this host only)'
  source=''; s_source='default (blank: import disabled)'
  pepper=''; s_pepper='generated'
  totp='';   s_totp='generated'
  jwt='';    s_jwt='generated'
  dbpw='';   s_dbpw='generated'

  if interactive; then
    open_tty
    echo
    info "First install: a few settings for $target"
    echo "    Press Enter to accept the [default]. Secrets are hidden as you type."
    echo

    # 1. Port
    while :; do
      ask a "1/7  Host port for Sirdar (127.0.0.1 only, behind your reverse proxy) [$def_port]: "
      [ -z "$a" ] && a="$def_port"
      case "$a" in ''|*[!0-9]*) echo "     Enter a number from 1024 to 65535."; continue ;; esac
      if [ "${#a}" -gt 5 ] || [ "$a" -lt 1024 ] || [ "$a" -gt 65535 ]; then
        echo "     Enter a number from 1024 to 65535."; continue
      fi
      if port_in_use "$a"; then
        warn "something is already listening on port $a."
        ask yn "     Use it anyway? [y/N]: "
        case "$yn" in [Yy]*) ;; *) continue ;; esac
      fi
      port="$a"
      if [ "$a" != "$def_port" ]; then s_port='provided'; fi
      break
    done

    # 2. Cookie domain
    while :; do
      ask a "2/7  Cookie domain for the sign-in cookie [blank = this host only]: "
      case "$a" in *[[:space:]]*) echo "     No spaces, please."; continue ;; esac
      if has_bad_chars "$a"; then echo "     No quotes, please."; continue; fi
      cookie="$a"
      [ -n "$a" ] && s_cookie='provided'
      break
    done

    # 3. Portal source database
    echo "3/7  Portal database URL for \"Import from portal\" (a read-only role is recommended)."
    while :; do
      ask a "     postgresql+asyncpg://user:pass@host:5432/db [blank = import disabled]: "
      if [ -n "$a" ]; then
        case "$a" in
          postgresql+asyncpg://?*) ;;
          *) echo "     It must start with postgresql+asyncpg://"; continue ;;
        esac
        case "$a" in *[[:space:]]*) echo "     No spaces, please."; continue ;; esac
        if has_bad_chars "$a"; then echo "     No quotes, please."; continue; fi
        s_source='provided'
      fi
      source="$a"
      break
    done

    # 4. Password pepper
    echo "4/7  Password pepper. Paste the portal's value to import portal users with their passwords."
    while :; do
      ask_secret a "     SS_PASSWORD_PEPPER [Enter = generate]: "
      if [ -n "$a" ] && has_bad_chars "$a"; then echo "     No quotes, please."; continue; fi
      [ -n "$a" ] && { pepper="$a"; s_pepper='provided'; }
      break
    done

    # 5. 2FA encryption key
    echo "5/7  2FA encryption key (a Fernet key). Paste the portal's value to keep imported 2FA working."
    while :; do
      ask_secret a "     SS_TOTP_ENCRYPTION_KEY [Enter = generate]: "
      if [ -n "$a" ]; then
        if [ "${#a}" -ne 44 ] || ! printf '%s' "$a" | grep -Eq '^[A-Za-z0-9_-]{43}=$'; then
          echo "     That doesn't look like a Fernet key (44 characters of URL-safe base64 ending in '=')."
          continue
        fi
        totp="$a"; s_totp='provided'
      fi
      break
    done

    # 6. JWT secret
    while :; do
      ask_secret a "6/7  SIRDAR_JWT_SECRET (at least 32 characters) [Enter = generate]: "
      if [ -n "$a" ]; then
        if [ "${#a}" -lt 32 ]; then echo "     It must be at least 32 characters."; continue; fi
        if has_bad_chars "$a"; then echo "     No quotes, please."; continue; fi
        jwt="$a"; s_jwt='provided'
      fi
      break
    done

    # 7. Database password
    while :; do
      ask_secret a "7/7  SIRDAR_DB_PASSWORD for Sirdar's own Postgres (16+ characters) [Enter = generate]: "
      if [ -n "$a" ]; then
        if [ "${#a}" -lt 16 ]; then echo "     It must be at least 16 characters."; continue; fi
        case "$a" in
          *[@:/?#]*|*[[:space:]]*|*"'"*) echo "     It goes into a URL: no @ : / ? # quotes or spaces."; continue ;;
        esac
        dbpw="$a"; s_dbpw='provided'
      fi
      break
    done
    exec 3<&-
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

# ── Platform detection and prerequisites ──────────────────────────────
detect_os() {
  OS=$(uname -s)
  case "$OS" in
    Darwin) ;;
    Linux)
      [ -r /etc/os-release ] || die "Can't read /etc/os-release; this installer supports Ubuntu, Debian and macOS."
      local id id_like
      # shellcheck disable=SC1091  # runtime file, not a script to lint
      id=$(. /etc/os-release && printf '%s' "${ID:-}")
      # shellcheck disable=SC1091
      id_like=$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")
      case " $id $id_like " in
        *" ubuntu "*) DISTRO=ubuntu ;;
        *" debian "*) DISTRO=debian ;;
        *) die "Unsupported Linux distribution '$id'. This installer supports Ubuntu, Debian and macOS." ;;
      esac
      ;;
    *) die "Unsupported OS '$OS'. This installer supports Ubuntu, Debian and macOS." ;;
  esac
}

apt_install() {
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

install_docker_apt_repo() {
  info "Adding Docker's official apt repository"
  as_root install -m 0755 -d /etc/apt/keyrings
  as_root curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
  as_root chmod a+r /etc/apt/keyrings/docker.asc
  local codename arch
  # Docker's docs: VERSION_CODENAME (UBUNTU_CODENAME first on Ubuntu derivatives).
  # shellcheck disable=SC1091
  codename=$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
  arch=$(dpkg --print-architecture)
  echo "deb [arch=$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$DISTRO $codename stable" \
    | as_root tee /etc/apt/sources.list.d/docker.list >/dev/null
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update
}

linux_prereqs() {
  local missing=() pkg
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v openssl >/dev/null 2>&1 || missing+=(openssl)
  [ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
  if [ "${#missing[@]}" -gt 0 ]; then
    info "Installing prerequisites: ${missing[*]}"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update
    apt_install "${missing[@]}"
  fi

  if ! command -v docker >/dev/null 2>&1; then
    info "Installing Docker Engine from Docker's apt repository"
    install_docker_apt_repo
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi

  # Daemon
  if ! docker info >/dev/null 2>&1 && ! as_root docker info >/dev/null 2>&1; then
    if command -v systemctl >/dev/null 2>&1; then
      info "Starting the Docker daemon"
      as_root systemctl enable --now docker || true
    fi
    as_root docker info >/dev/null 2>&1 || die "The Docker daemon isn't reachable. Start it (systemctl start docker) and re-run."
  fi

  # Who runs docker this time
  if is_root || docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  else
    DOCKER=(sudo docker)
    local me
    me=$(id -un)
    if ! id -nG "$me" | tr ' ' '\n' | grep -qx docker; then
      info "Adding $me to the docker group (takes effect on your next login)"
      as_root usermod -aG docker "$me"
      ADDED_TO_DOCKER_GROUP=1
    fi
  fi

  # Compose plugin
  if ! "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    info "Installing the Docker Compose plugin"
    pkg=docker-compose-plugin
    [ -f /etc/apt/sources.list.d/docker.list ] || install_docker_apt_repo
    apt_install "$pkg" || true
    "${DOCKER[@]}" compose version >/dev/null 2>&1 \
      || die "'docker compose' isn't available. Install Docker's compose plugin (https://docs.docker.com/compose/install/linux/) and re-run."
  fi
}

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
  # Owned by the invoking user, so git and the .env are theirs.
  if [ -d "$DIR" ] && [ -w "$DIR" ]; then return 0; fi
  if [ ! -d "$DIR" ] && mkdir -p "$DIR" 2>/dev/null; then return 0; fi
  info "Creating $DIR (needs sudo)"
  as_root mkdir -p "$DIR"
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
  [ "${DOCKER[0]}" = sudo ] && p="sudo docker"
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
  ask yn "Create the first Sirdar admin now? [Y/n]: "
  case "$yn" in [Nn]*) exec 3<&-; echo "    Later: $admin_cmd"; return 0 ;; esac
  while [ "$tries" -lt 3 ]; do
    tries=$((tries + 1))
    email=''; first=''; last=''
    while [ -z "$email" ]; do ask email "  Email: "; done
    while [ -z "$first" ]; do ask first "  First name: "; done
    while [ -z "$last" ];  do ask last  "  Last name: "; done
    # The CLI's own hidden password prompt needs the terminal on both ends.
    # shellcheck disable=SC2094
    if compose exec sirdar sirdar create-admin --email "$email" --first-name "$first" --last-name "$last" \
         <"$TTY_PATH" >"$TTY_PATH"; then
      info "Admin $email created"
      exec 3<&-
      return 0
    fi
    warn "create-admin failed."
    [ "$tries" -lt 3 ] || break
    ask yn "Try again? [Y/n]: "
    case "$yn" in [Nn]*) break ;; esac
  done
  exec 3<&-
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
  Install dir:  $DIR
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

main() {
  banner
  detect_os
  REPO="${REPO_URL:-https://github.com/encondata/BaseCampV3.git}"
  BRANCH="${SIRDAR_BRANCH:-main}"
  if [ "$OS" = Darwin ]; then DIR="${SIRDAR_DIR:-$HOME/sirdar}"; else DIR="${SIRDAR_DIR:-/opt/sirdar}"; fi

  info "Platform: $OS${DISTRO:+ ($DISTRO)}   Install dir: $DIR   Branch: $BRANCH"
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
