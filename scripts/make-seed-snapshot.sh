#!/usr/bin/env bash
# make-seed-snapshot.sh — build a Slipway snapshot from the Mac dev stack
# (docker-compose.dev.yml): the dev Postgres, every object of the dev bucket
# and the repo .env's SS_PASSWORD_PEPPER and SS_TOTP_ENCRYPTION_KEY.
#
#   scripts/make-seed-snapshot.sh [--out FILE] [--source NAME] [--env-file FILE]
#       [--pg-container NAME] [--s3-endpoint URL] [--python PATH] [--slipway CMD]
#
# Defaults: --out ./seed-<UTC time>.slipway-snapshot, --source mac-dev,
# --env-file <repo>/.env, --pg-container serversherpa-dev-postgres-1,
# --s3-endpoint http://127.0.0.1:9000, --python <repo>/api/.venv/bin/python
# (deploy/stack/objects.py needs boto3), --slipway slipway (Slipway's CLI).
#
# The file is encrypted with a passphrase: typed twice at a terminal, or one
# line on stdin (printf '%s\n' "$PASSPHRASE" | scripts/make-seed-snapshot.sh).
# Upload it on Slipway's Snapshots page, which asks for the passphrase.
set -euo pipefail
umask 077

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
OBJECTS="$REPO/deploy/stack/objects.py"
OUT="seed-$(date -u +%Y%m%dT%H%M%SZ).slipway-snapshot"
SOURCE=mac-dev
ENV_FILE="$REPO/.env"
PG=serversherpa-dev-postgres-1
ENDPOINT=http://127.0.0.1:9000
PY="$REPO/api/.venv/bin/python"
SLIPWAY=slipway
# What slipway.yml says about ServerSherpa's data: Slipway seeds only an app
# with this id and these formats.
APP=serversherpa
APP_NAME=ServerSherpa
DB_FORMAT=pg-custom
FILES_FORMAT=serversherpa-objects-v1
IDENTITY=SS_PASSWORD_PEPPER,SS_TOTP_ENCRYPTION_KEY

die() { echo "make-seed-snapshot: $*" >&2; exit 1; }
usage() { sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

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
    --slipway) SLIPWAY=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[[ -f $ENV_FILE ]] || die "no env file at $ENV_FILE (pass --env-file)"
[[ -x $PY ]] || die "no Python at $PY (pass --python)"
command -v "$SLIPWAY" >/dev/null 2>&1 \
  || die "no Slipway CLI ($SLIPWAY); install Slipway or pass --slipway"
[[ ! -e $OUT ]] || die "$OUT already exists"

# One value from the env file, read the way the API's dotenv loader reads it:
# the last assignment wins; a quoted value is what's inside the quotes, and
# only blanks or a "# comment" may follow it (dotenv skips any other line like
# that and keeps an earlier assignment, so it is refused here); an unquoted one
# loses a " # comment" after it and the blanks around it.
get() {
  local v q rest
  v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)
  v=${v%$'\r'}
  v=${v#"${v%%[![:space:]]*}"}
  case $v in
    \"*|\'*)
      q=${v:0:1}
      v=${v:1}
      if [[ $v == *"$q"* ]]; then
        rest=${v#*"$q"}
        v=${v%%"$q"*}
        rest=${rest#"${rest%%[![:space:]]*}"}
        [[ -z $rest || $rest == \#* ]] \
          || die "$1 in $ENV_FILE has text after its closing quote; remove it"
      fi ;;
    *) v=$(printf '%s' "$v" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//') ;;
  esac
  printf '%s' "$v"
}
for key in POSTGRES_USER POSTGRES_DB SS_SPACES_BUCKET SS_SPACES_ACCESS_KEY \
           SS_SPACES_SECRET_KEY SS_PASSWORD_PEPPER SS_TOTP_ENCRYPTION_KEY; do
  value=$(get "$key") || exit 1   # get has said why
  [[ -n $value ]] || die "$key isn't set in $ENV_FILE"
done
unset value
# The identity keys must be the kinds slipway.yml declares, or Slipway refuses
# the snapshot when it seeds; say so now, before the dump and the export.
[[ $(get SS_PASSWORD_PEPPER) =~ ^([0-9a-f]{2}){16,128}$ ]] \
  || die "SS_PASSWORD_PEPPER in $ENV_FILE isn't a hex key (32 to 256 lowercase hex characters)"
[[ $(get SS_TOTP_ENCRYPTION_KEY) =~ ^[A-Za-z0-9_-]{43}=$ ]] \
  || die "SS_TOTP_ENCRYPTION_KEY in $ENV_FILE isn't a Fernet key (44 characters ending in =)"
PGUSER=$(get POSTGRES_USER)
PGDB=$(get POSTGRES_DB)
BUCKET=$(get SS_SPACES_BUCKET)

work=$(mktemp -d "${TMPDIR:-/tmp}/seed-snapshot.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> Dumping $PGDB from $PG"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$PGDB" -Fc --no-owner --no-acl \
  > "$work/database" </dev/null || die "pg_dump failed"
docker exec "$PG" psql -U "$PGUSER" -d "$PGDB" -tAc \
  'SELECT version_num FROM alembic_version' > "$work/revision" </dev/null \
  || die "couldn't read the migration"

echo "==> Exporting bucket $BUCKET from $ENDPOINT"
# objects.py takes its S3 settings from the environment, never argv
SS_OBJECTS_ENDPOINT=$ENDPOINT SS_OBJECTS_KEY_ID=$(get SS_SPACES_ACCESS_KEY) \
SS_OBJECTS_SECRET=$(get SS_SPACES_SECRET_KEY) SS_OBJECTS_BUCKET=$BUCKET \
  "$PY" "$OBJECTS" export "$work/files" </dev/null || die "the object export failed"

# The identity keys, read by slipway snapshot pack and encrypted with the rest.
printf 'SS_PASSWORD_PEPPER=%s\nSS_TOTP_ENCRYPTION_KEY=%s\n' \
  "$(get SS_PASSWORD_PEPPER)" "$(get SS_TOTP_ENCRYPTION_KEY)" > "$work/identity.env"

commit=()
if sha=$(git -C "$REPO" rev-parse --verify -q HEAD 2>/dev/null); then commit=(--commit "$sha"); fi

echo "==> Packing $OUT"
# stdin passes through: the passphrase (prompted for twice at a terminal)
"$SLIPWAY" snapshot pack --app "$APP" --app-name "$APP_NAME" --repository encondata/BaseCampV3 \
  --format "$DB_FORMAT" --database "$work/database" --revision-file "$work/revision" \
  ${commit[@]+"${commit[@]}"} --files "$work/files" --files-format "$FILES_FORMAT" \
  --identity-env "$work/identity.env" --identity "$IDENTITY" --source "$SOURCE" \
  --passphrase-stdin --out "$OUT" || die "packing failed"
