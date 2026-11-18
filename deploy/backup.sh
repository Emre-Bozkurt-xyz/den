#!/usr/bin/env bash
#
# Den — database backup to R2 (BACKBONE §14 Stage 6).
#
#   pg_dump (postgres container) -> validate -> [encrypt] -> upload (api container) -> prune
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
#   bash deploy/backup.sh --local /some/dir     # keep the dump on THIS host instead
#                                               # of R2 (deploy.sh's pre-migration copy)
#
# Optional encryption (R2 mode only): set BACKUP_AGE_RECIPIENT=age1... in the
# env file and the validated dump is encrypted with `age` before upload. Needs
# `age` installed on the host — see deploy/README.md "Encrypting the dump".
#
# Scheduled via systemd — see deploy/systemd/ and deploy/README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="${DEN_ENV_FILE:-/opt/apps/den/secrets/.env}"
LOCAL_DIR=''

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    --local) LOCAL_DIR="${2:?--local needs a directory}"; shift 2 ;;
    -h|--help) sed -n '3,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
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

# Encryption recipient: the caller's environment wins (one-off runs), then
# the env file. Surrounding quotes are stripped — compose accepts both forms.
AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-$(envval BACKUP_AGE_RECIPIENT)}"
AGE_RECIPIENT="${AGE_RECIPIENT%$'\r'}"
AGE_RECIPIENT="${AGE_RECIPIENT%\"}"; AGE_RECIPIENT="${AGE_RECIPIENT#\"}"
AGE_RECIPIENT="${AGE_RECIPIENT%\'}"; AGE_RECIPIENT="${AGE_RECIPIENT#\'}"

# Refuse BEFORE dumping rather than after: if encryption was asked for, a
# missing tool must never degrade into uploading plaintext.
if [ -z "$LOCAL_DIR" ] && [ -n "$AGE_RECIPIENT" ]; then
  command -v age >/dev/null || fail "BACKUP_AGE_RECIPIENT is set but 'age' is not installed on this host.
Refusing to upload an unencrypted dump. Install it (Debian/Ubuntu: sudo apt install age)
or remove BACKUP_AGE_RECIPIENT from $ENV_FILE to go back to plaintext uploads."
fi

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Host-side temp file rather than piping pg_dump straight into the uploader:
# it lets us VALIDATE the dump before it's stored. A silently-truncated backup
# is worse than none — it looks like protection while restoring nothing.
# (mktemp creates files 0600: a dump holds every message and password hash.)
TMP="$(mktemp -t den-backup.XXXXXX)"
ENC=''
cleanup() { rm -f "$TMP" ${ENC:+"$ENC"}; }
trap cleanup EXIT

log "Dumping $PG_DB"
# -Fc = custom format: compressed, and restorable selectively with pg_restore.
dc exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" -Fc > "$TMP" \
  || fail "pg_dump failed (is the stack up? try: bash deploy/deploy.sh)"

SIZE="$(wc -c < "$TMP" | tr -d ' ')"
[ "$SIZE" -gt 1024 ] || fail "dump is only ${SIZE} bytes — treating as a failed dump, nothing stored"

log "Validating dump (${SIZE} bytes)"
# Parses the archive's table of contents. Catches truncation/corruption that a
# size check alone would miss. Reads only — never touches the live database.
# Always run on the PLAINTEXT, before any encryption below.
dc exec -T postgres pg_restore --list > /dev/null < "$TMP" \
  || fail "dump failed pg_restore --list validation — NOT storing a corrupt backup"

# ─── local mode: keep it on this host (deploy.sh's pre-migration copy) ─────
# Plaintext on purpose: it sits on the same disk as the live database, so
# encrypting it would protect nothing the database files don't already
# expose. Directory and file are owner-only (umask 077).
if [ -n "$LOCAL_DIR" ]; then
  LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-5}"
  # Anything but a positive integer falls back to 5 — a 0 here would prune
  # the dump that was just written.
  if ! [[ "$LOCAL_KEEP" =~ ^[0-9]+$ ]] || [ "$((10#$LOCAL_KEEP))" -lt 1 ]; then LOCAL_KEEP=5; fi
  LOCAL_KEEP="$((10#$LOCAL_KEEP))"
  DEST="$LOCAL_DIR/den-$(date -u +%Y%m%dT%H%M%SZ).dump"
  ( umask 077 && mkdir -p "$LOCAL_DIR" && cp "$TMP" "$DEST" ) \
    || fail "could not write $DEST"
  # Bounded retention, same reasoning as the R2 side. Names embed a
  # fixed-width UTC stamp, so C-locale glob order == chronological order.
  (
    LC_ALL=C
    shopt -s nullglob
    files=("$LOCAL_DIR"/den-*.dump)
    n=${#files[@]}
    if [ "$n" -gt "$LOCAL_KEEP" ]; then
      rm -f -- "${files[@]:0:$((n - LOCAL_KEEP))}"
      echo "pruned $((n - LOCAL_KEEP)) old local backup(s), $LOCAL_KEEP retained"
    fi
  )
  log "Local backup complete: $DEST"
  exit 0
fi

# ─── optional client-side encryption (R2 mode) ──────────────────────────────
UPLOAD="$TMP"
if [ -n "$AGE_RECIPIENT" ]; then
  log "Encrypting dump for $AGE_RECIPIENT"
  ENC="$(mktemp -t den-backup-enc.XXXXXX)"
  age -r "$AGE_RECIPIENT" -o "$ENC" "$TMP" || fail "age encryption failed — nothing uploaded"
  # The private key is (deliberately) not on this host, so a decrypt round
  # trip is impossible here; check that the output at least IS an age file.
  [ "$(head -c 21 "$ENC")" = "age-encryption.org/v1" ] \
    || fail "age output does not look like an age file — nothing uploaded"
  UPLOAD="$ENC"
fi

log "Uploading to R2 and pruning old backups"
# BACKUP_KEEP is read by the uploader inside the container; pass it through
# only when the caller set it, so the script's own default stays in one place.
if [ -n "${BACKUP_KEEP:-}" ]; then
  dc exec -T -e "BACKUP_KEEP=$BACKUP_KEEP" api node server/dist/scripts/backup.js upload < "$UPLOAD"
else
  dc exec -T api node server/dist/scripts/backup.js upload < "$UPLOAD"
fi

log "Backup complete"
