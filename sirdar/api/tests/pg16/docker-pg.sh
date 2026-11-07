#!/usr/bin/env bash
# Test helper: runs a Postgres 16 client tool (pg_dump, pg_restore) inside
# the dev sirdar-db container (postgres:16-alpine), for Macs whose own
# client tools are a newer major version than the test server (pg_restore
# 17+ sends `SET transaction_timeout`, which Postgres 16 rejects; their
# dumps are a format pg_restore 16 can't read). Used only when the local
# tools don't match the server (see conftest.pg_bin_dir_for_tests).
#
# The host's --host/--port are dropped (inside the container the server is
# 127.0.0.1:5432); PGPASSWORD is forwarded from the environment, never put
# on a command line. pg_restore's last argument (the dump file) is fed on
# stdin, and a -L/--use-list file (a host path) is copied into the
# container for the run; pg_dump writes to stdout.
set -euo pipefail
tool="$1"; shift
container="${SIRDAR_TEST_PG_CONTAINER:-serversherpa-dev-sirdar-db-1}"
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host|--port) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ "$tool" = pg_restore ]; then
  last=$((${#args[@]} - 1))
  input="${args[$last]}"
  unset "args[$last]"
  list=""
  for i in "${!args[@]}"; do
    case "${args[$i]}" in
      -L|--use-list)
        list="/tmp/pg-list-$$-$RANDOM"
        docker cp "${args[$((i + 1))]}" "$container:$list"
        args[$((i + 1))]="$list" ;;
      --use-list=*)
        list="/tmp/pg-list-$$-$RANDOM"
        docker cp "${args[$i]#--use-list=}" "$container:$list"
        args[$i]="--use-list=$list" ;;
    esac
  done
  rc=0
  docker exec -i -e PGPASSWORD "$container" \
    pg_restore --host 127.0.0.1 --port 5432 "${args[@]}" <"$input" || rc=$?
  if [ -n "$list" ]; then
    docker exec "$container" rm -f "$list" || true
  fi
  exit $rc
fi
exec docker exec -i -e PGPASSWORD "$container" "$tool" --host 127.0.0.1 --port 5432 "${args[@]}"
