#!/usr/bin/env bash
# make-sql-seed-snapshot.sh — build a Sirdar snapshot bundle from a plain-SQL
# ServerSherpa dump plus only the dev-bucket objects that dump references.
#
#   scripts/make-sql-seed-snapshot.sh --sql FILE [--out FILE] [--source NAME]
#       [--env-file FILE] [--pg-container NAME] [--s3-endpoint URL]
#       [--python PATH] [--keep-db]
#
# The dump is loaded into a throwaway database (seed_tmp_<random>) in the dev
# Postgres, which is dropped on exit unless --keep-db. The storage-key columns
# (storage_key, preview_key, *_storage_key, avatar_key, logo_key, file_key)
# are found from information_schema; their values are fetched from the dev bucket.
# Defaults: --source the SQL file's name without extension, --out
# ./seed-<source>.tar.gz, --env-file <repo>/.env, --pg-container
# serversherpa-dev-postgres-1, --s3-endpoint http://127.0.0.1:9000,
# --python <repo>/api/.venv/bin/python (it needs boto3).
#
# The bundle uses the env file's SS_PASSWORD_PEPPER and SS_TOTP_ENCRYPTION_KEY,
# so the dump's password hashes must have been made with that pepper. Upload it
# on Sirdar's Deploy page (Snapshots, Upload), then delete it: until Sirdar
# encrypts them, its keys.env holds the two keys in plaintext.
set -euo pipefail
umask 077
case $- in *x*) echo "make-sql-seed-snapshot: refusing to run under set -x (it would print the keys)" >&2; exit 1 ;; esac

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TOOL="$REPO/sirdar/api/src/sirdar_api/deploy/bundle.py"
SQL=
OUT=
SOURCE=
ENV_FILE="$REPO/.env"
PG=serversherpa-dev-postgres-1
ENDPOINT=http://127.0.0.1:9000
PY="$REPO/api/.venv/bin/python"
KEEP=0

die() { echo "make-sql-seed-snapshot: $*" >&2; exit 1; }
usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2; }

while [[ $# -gt 0 ]]; do
  [[ $1 == -h || $1 == --help ]] && usage
  if [[ $1 == --keep-db ]]; then KEEP=1; shift; continue; fi
  [[ $# -ge 2 ]] || usage
  case $1 in
    --sql) SQL=$2 ;;
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

[[ -n $SQL ]] || usage
[[ -f $SQL ]] || die "no SQL file at $SQL"
if [[ -z $SOURCE ]]; then
  SOURCE=$(basename "$SQL"); SOURCE=${SOURCE%.*}
fi
[[ -n $OUT ]] || OUT="seed-$SOURCE.tar.gz"
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

# Run psql inside the container against the maintenance database or the scratch one.
psql_admin() { docker exec -i "$PG" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 "$@"; }

work=$(mktemp -d "${TMPDIR:-/tmp}/sql-seed-snapshot.XXXXXX")
TMPDB=
cleanup() {
  local rc=$?
  trap - EXIT
  rm -rf "$work"
  if [[ -n $TMPDB ]]; then
    if [[ $KEEP -eq 1 ]]; then
      echo "Kept throwaway database $TMPDB in $PG (drop it when done)." >&2
    else
      psql_admin -qc "DROP DATABASE IF EXISTS \"$TMPDB\" WITH (FORCE)" </dev/null >/dev/null 2>&1 \
        || echo "make-sql-seed-snapshot: couldn't drop $TMPDB; drop it by hand" >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

suffix=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 10 || true)
# A dump made with -C (or pg_dumpall) switches databases or creates
# roles: loading it would write outside the throwaway database.
if grep -Eiq '^[[:space:]]*(\\(c|connect)([[:space:]]|$)|(create|drop|alter)[[:space:]]+(database|role|user)[[:space:]])' "$SQL"; then
  die "$SQL connects to another database or creates databases/roles; dump it without -C/--create (plain pg_dump of one database)"
fi

name="seed_tmp_$suffix"
exists=$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$name'" </dev/null) \
  || die "couldn't query $PG"
[[ -z $exists ]] || die "database $name already exists"
echo "==> Creating throwaway database $name in $PG"
TMPDB=$name
psql_admin -qc "CREATE DATABASE \"$name\"" </dev/null || die "couldn't create $name"

echo "==> Loading $SQL"
if ! docker exec -i "$PG" psql -U "$PGUSER" -d "$name" -v ON_ERROR_STOP=1 -q \
     < "$SQL" > "$work/load.log" 2>&1; then
  grep -E '^(psql:.*)?ERROR:' "$work/load.log" | head -n 5 | cut -c1-300 >&2 || true
  die "loading the SQL failed"
fi

pgq() { docker exec -i "$PG" psql -U "$PGUSER" -d "$name" -v ON_ERROR_STOP=1 -tAq "$@"; }
revision=$(pgq -c 'SELECT version_num FROM alembic_version' </dev/null) \
  || die "couldn't read the migration (does the dump have alembic_version?)"
revision=${revision//[[:space:]]/}

echo "==> Finding storage-key columns"
pgq -F $'\t' -c "SELECT format('%I', table_name), format('%I', column_name) FROM information_schema.columns
  WHERE table_schema = 'public' AND udt_name IN ('text', 'varchar', 'citext')
    AND (column_name IN ('storage_key', 'preview_key', 'avatar_key', 'logo_key', 'file_key')
         OR column_name LIKE '%\\_storage\\_key')
  ORDER BY table_name, column_name" </dev/null > "$work/columns.txt" \
  || die "couldn't list the storage-key columns"
: > "$work/keys.txt"
: > "$work/counts.txt"
while IFS=$'\t' read -r tbl col; do
  [[ -n $tbl ]] || continue
  pgq -c "SELECT DISTINCT $col FROM public.$tbl WHERE $col IS NOT NULL AND $col <> ''" \
    </dev/null > "$work/col.txt" || die "couldn't read $tbl.$col"
  n=$(grep -c . "$work/col.txt" || true)
  printf '%s.%s %s\n' "$tbl" "$col" "$n" >> "$work/counts.txt"
  cat "$work/col.txt" >> "$work/keys.txt"
done < "$work/columns.txt"
sort -u "$work/keys.txt" -o "$work/keys.txt"
echo "    $(grep -c . "$work/counts.txt" || true) columns:"
sed 's/^/      /' "$work/counts.txt"
echo "    $(grep -c . "$work/keys.txt" || true) distinct keys"

echo "==> Dumping $name"
docker exec "$PG" pg_dump -U "$PGUSER" -d "$name" -Fc --no-owner --no-acl \
  > "$work/db.dump" </dev/null || die "pg_dump failed"

echo "==> Exporting the referenced objects of $BUCKET from $ENDPOINT"
SNAP_S3_SECRET=$(get SS_SPACES_SECRET_KEY) "$PY" "$TOOL" export-objects \
  --out "$work/objects.tar" --endpoint "$ENDPOINT" --key-id "$(get SS_SPACES_ACCESS_KEY)" \
  --bucket "$BUCKET" --keys-file "$work/keys.txt" > "$work/objects.json" \
  || die "the object export failed (see above)"

printf 'SS_PASSWORD_PEPPER=%s\nSS_TOTP_ENCRYPTION_KEY=%s\n' \
  "$(get SS_PASSWORD_PEPPER)" "$(get SS_TOTP_ENCRYPTION_KEY)" > "$work/keys.env"
echo "Note: the bundle uses the keys in $ENV_FILE, so the dump's password hashes" \
     "must have been made with that pepper."

echo "==> Packing $OUT"
"$PY" "$TOOL" pack --out "$OUT" --source "$SOURCE" --revision "$revision" --bucket "$BUCKET" \
  --db "$work/db.dump" --objects "$work/objects.tar" --keys-env "$work/keys.env" \
  > "$work/manifest.json" || die "packing failed"
"$PY" "$TOOL" verify "$OUT" > /dev/null || die "the bundle failed verification"

"$PY" - "$OUT" "$work/manifest.json" "$work/counts.txt" <<'PY'
import hashlib, json, os, sys
out, manifest = sys.argv[1], json.load(open(sys.argv[2]))
counts = [line.split() for line in open(sys.argv[3]) if line.strip()]
digest = hashlib.sha256()
with open(out, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        digest.update(chunk)
per_table = "\n".join(f"    {name:<40} {n}" for name, n in counts)
print(f"""
Snapshot bundle: {os.path.abspath(out)}  (verified)
  size       {os.path.getsize(out):,} bytes
  sha256     {digest.hexdigest()}
  source     {manifest['source']}
  migration  {manifest['alembic_revision']}
  objects    {manifest['object_count']:,} ({manifest['object_bytes']:,} bytes) from {manifest['bucket']}
  keys per column:
{per_table}

It holds the env file's password pepper and TOTP key in plaintext until Sirdar
takes it. Upload it on Sirdar's Deploy page (Snapshots, Upload), then delete it.""")
PY
