#!/usr/bin/env bash
# make-seed-snapshot.sh — build a Sirdar snapshot bundle from the Mac dev
# stack (docker-compose.dev.yml): the dev Postgres, every object of the dev
# bucket and the repo .env's SS_PASSWORD_PEPPER and SS_TOTP_ENCRYPTION_KEY.
#
#   scripts/make-seed-snapshot.sh [--out FILE] [--source NAME] [--env-file FILE]
#       [--pg-container NAME] [--s3-endpoint URL] [--python PATH]
#
# Defaults: --out ./seed-<UTC time>.tar.gz, --source mac-dev, --env-file <repo>/.env,
# --pg-container serversherpa-dev-postgres-1, --s3-endpoint http://127.0.0.1:9000,
# --python <repo>/api/.venv/bin/python (it needs boto3).
#
# Upload the file on Sirdar's Deploy page (Snapshots, Upload), then delete it:
# until Sirdar encrypts them, its keys.env holds the two keys in plaintext.
set -euo pipefail
umask 077

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOOL="$REPO/sirdar/api/src/sirdar_api/deploy/bundle.py"
OUT="seed-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
SOURCE=mac-dev
ENV_FILE="$REPO/.env"
PG=serversherpa-dev-postgres-1
ENDPOINT=http://127.0.0.1:9000
PY="$REPO/api/.venv/bin/python"

die() { echo "make-seed-snapshot: $*" >&2; exit 1; }
usage() { sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  [[ $1 == -h || $1 == --help ]] && usage
  [[ $# -ge 2 ]] || usage
  case $1 in
    --out) OUT=$2 ;;
    --source) SOURCE=$2 ;;
    --env-file) ENV_FILE=$2 ;;
    --pg-container) PG=$2 ;;
    --s3-endpoint) ENDPOINT=$2 ;;
    --python) PY=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[[ -f $ENV_FILE ]] || die "no env file at $ENV_FILE (pass --env-file)"
[[ -x $PY ]] || die "no Python at $PY (pass --python)"
[[ ! -e $OUT ]] || die "$OUT already exists"

# One value from the env file: last assignment wins, surrounding quotes dropped.
get() {
  local v
  v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)
  v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}
  printf '%s' "$v"
}
for key in POSTGRES_USER POSTGRES_DB SS_SPACES_BUCKET SS_SPACES_ACCESS_KEY \
           SS_SPACES_SECRET_KEY SS_PASSWORD_PEPPER SS_TOTP_ENCRYPTION_KEY; do
  [[ -n $(get "$key") ]] || die "$key isn't set in $ENV_FILE"
done
PGUSER=$(get POSTGRES_USER)
PGDB=$(get POSTGRES_DB)
BUCKET=$(get SS_SPACES_BUCKET)

work=$(mktemp -d "${TMPDIR:-/tmp}/seed-snapshot.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> Dumping $PGDB from $PG"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -Fc --no-owner --no-acl \
  > "$work/db.dump" </dev/null || die "pg_dump failed"
revision=$(docker exec "$PG" psql -U "$PGUSER" -d "$PGDB" -tAc \
  'SELECT version_num FROM alembic_version' </dev/null) || die "couldn't read the migration"
revision=${revision//[[:space:]]/}

echo "==> Exporting bucket $BUCKET from $ENDPOINT"
SNAP_S3_SECRET=$(get SS_SPACES_SECRET_KEY) "$PY" "$TOOL" export-objects \
  --out "$work/objects.tar" --endpoint "$ENDPOINT" --key-id "$(get SS_SPACES_ACCESS_KEY)" \
  --bucket "$BUCKET" > "$work/objects.json" || die "the object export failed"

printf 'SS_PASSWORD_PEPPER=%s\nSS_TOTP_ENCRYPTION_KEY=%s\n' \
  "$(get SS_PASSWORD_PEPPER)" "$(get SS_TOTP_ENCRYPTION_KEY)" > "$work/keys.env"

echo "==> Packing $OUT"
"$PY" "$TOOL" pack --out "$OUT" --source "$SOURCE" --revision "$revision" --bucket "$BUCKET" \
  --db "$work/db.dump" --objects "$work/objects.tar" --keys-env "$work/keys.env" \
  > "$work/manifest.json" || die "packing failed"

"$PY" - "$OUT" "$work/manifest.json" <<'PY'
import hashlib, json, os, sys
out, manifest = sys.argv[1], json.load(open(sys.argv[2]))
digest = hashlib.sha256()
with open(out, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        digest.update(chunk)
print(f"""
Snapshot bundle: {os.path.abspath(out)}
  size       {os.path.getsize(out):,} bytes
  sha256     {digest.hexdigest()}
  source     {manifest['source']}
  migration  {manifest['alembic_revision']}
  objects    {manifest['object_count']:,} ({manifest['object_bytes']:,} bytes) from {manifest['bucket']}

It holds the dev password pepper and TOTP key in plaintext until Sirdar takes
it. Upload it on Sirdar's Deploy page (Snapshots, Upload), then delete it.""")
PY
