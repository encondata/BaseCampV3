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
# stdin; pg_dump writes to stdout.
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
  exec docker exec -i -e PGPASSWORD "$container" \
    pg_restore --host 127.0.0.1 --port 5432 "${args[@]}" <"$input"
fi
exec docker exec -i -e PGPASSWORD "$container" "$tool" --host 127.0.0.1 --port 5432 "${args[@]}"
