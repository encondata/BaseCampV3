#!/usr/bin/env bash
# Runs the real ss-stack against a data server's .env, the way Slipway writes
# it for an environment's data server (slipway.yml data.server): only
# POSTGRES_PASSWORD and SPACES_SECRET_KEY set, every SS_* secret written empty
# (SS_JWT_SECRET=, ...), and STACK_DB_PUBLISH=1. No Docker daemon is needed:
# a fake `docker` on PATH logs every call and, like Compose, fails when a
# compose file it is given has a ${VAR:?...} whose VAR is empty or missing in
# the .env and the environment.
#
#   deploy/stack/test-server-role.sh [<.env>]
#
# With a .env (for example one Slipway wrote for a data server) the checks
# run on a copy of it instead of the one made from env.example. SS_STACK=<path>
# runs another ss-stack (it must sit in a deploy/stack folder with the
# compose files), which is how this test is shown to fail on an ss-stack
# without the data server changes.
#
# Checks (every one runs; exits 1 at the end if any failed):
#   1. down, restore, pgdump, revision, export-objects, import-objects,
#      has-data --server, data, clear-sessions and ps succeed, and every
#      compose file they name is in db/ or storage/
#   2. down stops storage then db, and restore stops no app stack
#   3. has-data --server answers 3 without the volume, 0 with ServerSherpa's
#      tables and 3 without them; has-data without --server still answers 4
#   4. export-objects and import-objects use the data server's own SeaweedFS
#   5. build succeeds and names only build.yml
set -uo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SS_STACK="${SS_STACK:-$STACK_DIR/ss-stack}"
STACK_UNDER_TEST="$(cd "$(dirname "$SS_STACK")" && pwd)"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/ss-server-role.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ENV_DIR="$WORK/env"
mkdir -p "$ENV_DIR" "$WORK/bin"
LOG="$WORK/docker.log"

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [<.env>]" >&2
  exit 2
elif [[ $# -eq 1 ]]; then
  [[ -f $1 ]] || { echo "no such file: $1" >&2; exit 2; }
  cp "$1" "$ENV_DIR/.env"
else
  # env.example as a data server's .env: the two data secrets set, every
  # SS_* secret empty, the database published to two app servers.
  sed -e 's/^\(SS_[A-Z0-9_]*\)=CHANGEME$/\1=/' \
      -e 's/=CHANGEME$/=0123abcd0123abcd/' \
      -e 's/^STACK_ENV=.*/STACK_ENV=uat-data/' \
      "$STACK_DIR/env.example" > "$ENV_DIR/.env"
  printf '%s\n' STACK_DB_PUBLISH=1 STACK_DB_PORT=5432 STACK_DB_ALLOW=10.0.0.11,10.0.0.12 \
    >> "$ENV_DIR/.env"
fi
chmod 600 "$ENV_DIR/.env"
ENV_DIR=$(cd "$ENV_DIR" && pwd -P)   # ss-stack logs the physical path (macOS /private/var)

# One value from the .env, as ss-stack reads it: last assignment wins,
# surrounding quotes dropped.
env_value() {
  local v
  v=$(sed -n "s/^$1=//p" "$ENV_DIR/.env" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

STACK_ENV=$(env_value STACK_ENV)
VOLUME="ss-$STACK_ENV-db_pgdata"
[[ $(env_value STACK_DB_PUBLISH) == 1 ]] \
  || { echo "the .env must be a data server's (STACK_DB_PUBLISH=1)" >&2; exit 2; }
[[ -z $(env_value SS_JWT_SECRET) ]] \
  || { echo "the .env must leave SS_JWT_SECRET empty, as a data server's does" >&2; exit 2; }

cat > "$WORK/bin/docker" <<'SHIM'
#!/usr/bin/env bash
# A fake docker: logs every call, and checks a compose call's files the way
# Compose interpolates them.
printf '%s\n' "$*" >> "$DOCKER_LOG"

# A value as Compose sees it: the environment first, then the --env-file.
value_of() {  # value_of <name> <env-file>
  if [[ -n ${!1+x} ]]; then printf '%s' "${!1}"; return; fi
  [[ -n $2 ]] || return 0
  local v
  v=$(sed -n "s/^$1=//p" "$2" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}

if [[ ${1:-} == compose ]]; then
  shift
  env_file="" files=()
  while [[ $# -gt 0 ]]; do
    case $1 in
      --env-file) env_file=$2; shift 2 ;;
      -f) files+=("$2"); shift 2 ;;
      --profile|-p) shift 2 ;;
      *) break ;;
    esac
  done
  for f in ${files[@]+"${files[@]}"}; do
    [[ -f $f ]] || { echo "open $f: no such file or directory" >&2; exit 1; }
    # Every ${VAR:?...}, nested ones too (stricter than Compose, which skips
    # a default it doesn't use); $${...} is Compose's escaped literal.
    for name in $(grep -oE '(^|[^$])\$\{[A-Za-z_][A-Za-z0-9_]*:\?' "$f" \
                    | sed -E 's/.*\$\{([A-Za-z_][A-Za-z0-9_]*):\?/\1/' | sort -u); do
      if [[ -z $(value_of "$name" "$env_file") ]]; then
        echo "error while interpolating $f: required variable $name is missing a value" >&2
        exit 1
      fi
    done
  done
  case "$*" in
    *"to_regclass('public.alembic_version') IS NOT NULL") echo "${FAKE_HAS_TABLES:-f}" ;;
    *" ps --status running -q postgres") ;;
    *pg_dump*) printf 'PGDMP-fake' ;;
    *pg_restore*) cat > /dev/null ;;
    *"alembic_version"*) echo 0042 ;;
  esac
  exit 0
fi

case "$*" in
  "network inspect "*) exit 0 ;;
  "volume ls -q") [[ -n ${FAKE_VOLUMES:-} ]] && printf '%s\n' $FAKE_VOLUMES; exit 0 ;;
  *"python /objects.py "*)
    # what objects.py would be given (never the secret itself)
    printf 'endpoint=%s secret=%s\n' "${SS_OBJECTS_ENDPOINT-unset}" \
      "$([[ -n ${SS_OBJECTS_SECRET:-} ]] && echo set || echo empty)" >> "$DOCKER_LOG.objects"
    exit 0 ;;
  *pg_restore*) cat > /dev/null; exit 0 ;;
esac
exit 0
SHIM
chmod 755 "$WORK/bin/docker"

FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }
pass() { echo "ok:   $*"; }

# run <label> <ss-stack args…>: ss-stack with the fake docker and a fresh log;
# sets OUT (stdout and stderr) and CODE.
run() {
  local label=$1; shift
  : > "$LOG"
  OUT=$(PATH="$WORK/bin:$PATH" DOCKER_LOG="$LOG" FAKE_VOLUMES="${FAKE_VOLUMES:-}" \
        FAKE_HAS_TABLES="${FAKE_HAS_TABLES:-}" bash "$SS_STACK" "$@" 2>&1 </dev/null)
  CODE=$?
  LABEL=$label
}

# The compose files the last run named, one per line, relative to deploy/stack.
compose_files() {
  grep '^compose ' "$LOG" | grep -oE -- "-f [^ ]+" | sed -e 's/^-f //' \
    -e "s|^$STACK_UNDER_TEST/||" | sort -u
}

# check_data_only [<code>]: the last run exited <code> (default 0) and named
# only db/ and storage/ compose files.
check_data_only() {
  local want=${1:-0} files bad
  if [[ $CODE -ne $want ]]; then
    fail "$LABEL exited $CODE, not $want: $(tail -n 3 <<<"$OUT" | tr '\n' ' ')"
    local named
    named=$(compose_files | tr '\n' ' ')
    [[ -z $named ]] || echo "      it named: $named"
    return
  fi
  files=$(compose_files)
  bad=$(grep -vE '^(db|storage)/' <<<"$files" | grep -v '^$' | tr '\n' ' ')
  if [[ -n $bad ]]; then
    fail "$LABEL named $bad"
  else
    local shown=${files//$'\n'/ }
    pass "$LABEL: $CODE (${shown:-no compose file})"
  fi
}

DUMP="$WORK/in.dump"
printf 'PGDMP-restore-me' > "$DUMP"
TAR="$WORK/in.tar"
printf 'tar' > "$TAR"

# 1, 2. Each command on the data server's .env.
run "down" down "$ENV_DIR"; check_data_only
if [[ $CODE -eq 0 ]]; then
  order=$(sed -nE 's#^compose .*/(db|storage)/compose\.yml.* down$#\1#p' "$LOG" | tr '\n' ' ')
  [[ $order == "storage db " ]] || fail "down stopped '$order', not storage then db"
fi

run "restore" restore "$ENV_DIR" "$DUMP"; check_data_only
if grep -qE '^compose .* stop$' "$LOG"; then
  fail "restore stopped a stack: $(grep -E '^compose .* stop$' "$LOG" | tr '\n' ' ')"
fi
if [[ $CODE -eq 0 ]] && ! grep -q 'pg_restore' "$LOG"; then fail "restore didn't run pg_restore"; fi

run "pgdump" pgdump "$ENV_DIR" "$WORK/out.dump"; check_data_only
[[ $CODE -ne 0 || $(cat "$WORK/out.dump" 2>/dev/null) == PGDMP-fake ]] || fail "pgdump wrote no dump"

run "revision" revision "$ENV_DIR"; check_data_only
run "clear-sessions" clear-sessions "$ENV_DIR"; check_data_only
run "ps" ps "$ENV_DIR"; check_data_only

run "data" data "$ENV_DIR"; check_data_only
if [[ $CODE -eq 0 ]]; then
  grep -qE '^host serversherpa serversherpa [0-9.]+/32 scram-sha-256$' "$ENV_DIR/pg_hba.conf" \
    2>/dev/null || fail "data wrote no pg_hba.conf for STACK_DB_ALLOW"
fi

# 4. The objects commands run objects.py (no compose file) against this host's SeaweedFS.
: > "$LOG.objects"
run "export-objects" export-objects "$ENV_DIR" "$WORK/out.tar"; check_data_only
run "import-objects" import-objects "$ENV_DIR" "$TAR"; check_data_only
objects=$(sort -u "$LOG.objects")
[[ $objects == "endpoint=http://seaweedfs:8333 secret=set" ]] \
  || fail "the objects commands used '${objects//$'\n'/; }', not this host's SeaweedFS with its key"

# 3. has-data --server answers for this host's own database.
FAKE_VOLUMES="other-volume" run "has-data --server (no volume)" has-data "$ENV_DIR" --server
if [[ $CODE -eq 3 ]]; then
  if grep -q '^compose ' "$LOG"; then fail "$LABEL started something"; else pass "$LABEL: 3"; fi
else
  fail "$LABEL exited $CODE, not 3: $(tail -n 2 <<<"$OUT" | tr '\n' ' ')"
fi
FAKE_VOLUMES="other-volume $VOLUME" FAKE_HAS_TABLES=t run "has-data --server (tables)" \
  has-data "$ENV_DIR" --server
check_data_only 0
FAKE_VOLUMES="$VOLUME" FAKE_HAS_TABLES=f run "has-data --server (no tables)" has-data "$ENV_DIR" --server
check_data_only 3
FAKE_VOLUMES="$VOLUME" FAKE_HAS_TABLES=t run "has-data without --server" has-data "$ENV_DIR"
if [[ $CODE -eq 4 ]]; then pass "$LABEL: 4"; else fail "$LABEL exited $CODE, not 4"; fi

# 5. build makes every image (the data server's export-objects needs the api
# image) from build.yml alone.
run "build" build "$ENV_DIR"
if [[ $CODE -ne 0 ]]; then
  fail "build exited $CODE: $(tail -n 2 <<<"$OUT" | tr '\n' ' ')"
elif [[ $(compose_files) != build.yml ]]; then
  fail "build named $(compose_files | tr '\n' ' ')"
else
  pass "build (build.yml)"
fi

if [[ $FAILED -ne 0 ]]; then
  echo "test-server-role: FAILED"
  exit 1
fi
echo "test-server-role: every check passed"
