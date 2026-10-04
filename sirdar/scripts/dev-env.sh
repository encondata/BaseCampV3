#!/usr/bin/env bash
# Writes sirdar/.env for local development. The pepper and TOTP key are
# copied from the repo-root .env (they MUST match the portal's), and the
# import source points at the dev portal Postgres. Re-run safely: it
# keeps an existing SIRDAR_JWT_SECRET and SIRDAR_SECRETS_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT_ENV=../.env
[[ -f "$ROOT_ENV" ]] || { echo "error: $ROOT_ENV not found" >&2; exit 1; }
get() { grep -E "^$1=" "$ROOT_ENV" | head -1 | cut -d= -f2-; }
JWT=$(grep -E '^SIRDAR_JWT_SECRET=' .env 2>/dev/null | cut -d= -f2- || true)
[[ -n "$JWT" ]] || JWT=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
SECRETS=$(grep -E '^SIRDAR_SECRETS_KEY=' .env 2>/dev/null | cut -d= -f2- || true)
[[ -n "$SECRETS" ]] || SECRETS=$(python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')
SOURCE=$(get SS_DATABASE_URL)
cat > .env <<EOT
SIRDAR_ENV=development
SIRDAR_DATABASE_URL=postgresql+asyncpg://sirdar:sirdar@127.0.0.1:5434/sirdar
SIRDAR_SOURCE_DATABASE_URL=$SOURCE
SIRDAR_JWT_SECRET=$JWT
SS_PASSWORD_PEPPER=$(get SS_PASSWORD_PEPPER)
SS_TOTP_ENCRYPTION_KEY=$(get SS_TOTP_ENCRYPTION_KEY)
SIRDAR_DEPLOY_TARGETS_FILE=$PWD/config/deploy-targets.env
SIRDAR_SECRETS_KEY=$SECRETS
SIRDAR_RUNNER_DIR=$PWD/runner
SIRDAR_SNAPSHOTS_DIR=$PWD/snapshots
EOT
chmod 600 .env
echo "wrote sirdar/.env"
