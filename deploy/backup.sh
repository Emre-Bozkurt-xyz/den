#!/usr/bin/env bash
#
# Den — database backup to R2 (BACKBONE §14 Stage 6).
#
#   pg_dump (postgres container) -> validate -> upload (api container) -> prune
#
# Runs entirely through the existing containers: the dump comes from the
# postgres image (which has pg_dump/pg_restore) and the upload runs in the api
# image (which already holds the R2 credentials and SDK). Nothing new gets
# installed on the host and the R2 keys are never copied anywhere.
#
# Usage:
#   bash deploy/backup.sh                       # default env file
#   bash deploy/backup.sh --env-file /path/.env
#   BACKUP_KEEP=14 bash deploy/backup.sh        # override retention for one run
#
# Scheduled via systemd — see deploy/systemd/ and deploy/README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="${DEN_ENV_FILE:-/opt/apps/den/secrets/.env}"

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    -h|--help) sed -n '3,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$COMPOSE_FILE" ] || fail "compose file missing at $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || fail "env file not found at $ENV_FILE"

envval() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
PG_USER="$(envval POSTGRES_USER)"; PG_USER="${PG_USER:-den}"
PG_DB="$(envval POSTGRES_DB)";     PG_DB="${PG_DB:-den}"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Host-side temp file rather than piping pg_dump straight into the uploader:
# it lets us VALIDATE the dump before it's stored. A silently-truncated backup
# is worse than none — it looks like protection while restoring nothing.
TMP="$(mktemp -t den-backup.XXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

log "Dumping $PG_DB"
# -Fc = custom format: compressed, and restorable selectively with pg_restore.
dc exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$TMP" \
  || fail "pg_dump failed (is the stack up? try: bash deploy/deploy.sh)"

SIZE="$(wc -c < "$TMP" | tr -d ' ')"
[ "$SIZE" -gt 1024 ] || fail "dump is only ${SIZE} bytes — treating as a failed dump, nothing uploaded"

log "Validating dump (${SIZE} bytes)"
# Parses the archive's table of contents. Catches truncation/corruption that a
# size check alone would miss. Reads only — never touches the live database.
dc exec -T postgres pg_restore --list > /dev/null < "$TMP" \
  || fail "dump failed pg_restore --list validation — NOT uploading a corrupt backup"

log "Uploading to R2 and pruning old backups"
# BACKUP_KEEP is read by the uploader inside the container; pass it through
# only when the caller set it, so the script's own default stays in one place.
if [ -n "${BACKUP_KEEP:-}" ]; then
  dc exec -T -e "BACKUP_KEEP=$BACKUP_KEEP" api node server/dist/scripts/backup.js upload < "$TMP"
else
  dc exec -T api node server/dist/scripts/backup.js upload < "$TMP"
fi

log "Backup complete"
