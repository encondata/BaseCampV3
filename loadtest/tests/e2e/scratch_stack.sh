#!/usr/bin/env bash
# A throwaway BaseCamp server on 127.0.0.1:8010 for real-server load test runs.
#
#   loadtest/tests/e2e/scratch_stack.sh up       # create, migrate, start
#   loadtest/tests/e2e/scratch_stack.sh status   # what is running
#   loadtest/tests/e2e/scratch_stack.sh down     # stop what up started, drop, remove
#   loadtest/tests/e2e/scratch_stack.sh restart  # restart the processes only
#
# It only ever touches the database serversherpa_loadtest and the bucket
# serversherpa-loadtest (both fixed in scratch_stack.py, never taken from an
# argument or the environment). Logs, pid files and the generated admin password
# go to LOADTEST_SCRATCH_DIR. See scratch_stack.py for the details.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
python="$root/api/.venv/bin/python"

if [[ ! -x "$python" ]]; then
  echo "scratch_stack: no API virtualenv at $root/api/.venv" >&2
  exit 1
fi
# the database name is fixed; refuse an edited copy of the Python side that is not
if ! grep -q '^SCRATCH_DB = "serversherpa_loadtest" ' "$here/scratch_stack.py"; then
  echo "scratch_stack: scratch_stack.py does not name serversherpa_loadtest; refusing" >&2
  exit 1
fi
exec "$python" -I "$here/scratch_stack.py" "$@"
