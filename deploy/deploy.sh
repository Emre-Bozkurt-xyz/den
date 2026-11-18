#!/usr/bin/env bash
#
# Den — the one deploy path. Both the human and CI run THIS script, so the
# two can't drift apart. (They did once: manual deploys from
# /opt/apps/den/repo kept working while every runner deploy failed, and the
# breakage went unnoticed for days because the manual route papered over it.)
#
# Usage:
#   bash deploy/deploy.sh                      # uses the default env file
#   bash deploy/deploy.sh --env-file /path/.env
#   DEN_ENV_FILE=/path/.env bash deploy/deploy.sh
#   DEN_SKIP_BACKUP=1 bash deploy/deploy.sh    # emergency only — see README
#
# Invoked with `bash ...` rather than `./deploy.sh` on purpose: the repo is
# authored on Windows, which can't set the POSIX exec bit. The bit IS stored
# in git (`git update-index --chmod=+x`), so `./deploy/deploy.sh` works too —
# but going through `bash` means a lost exec bit can never break a deploy.
#
# Sequence (each step only runs if the previous one succeeded):
#   preflight -> build new images (nothing running changes)
#   -> tag what's running as :previous (rollback target)
#   -> postgres up + healthy -> pre-migration dump to the host (backup.sh --local)
#   -> migrate using the NEW image in a one-off container, while the OLD api
#      keeps serving -> swap api -> wait for real /health -> swap web
#   -> probe /health through Caddy -> prune -> status.
set -euo pipefail

# Resolve paths from THIS FILE's location, never the caller's cwd, so the
# script behaves identically whether it's run from the repo root, from
# deploy/, or by the runner from its own workspace.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

ENV_FILE="${DEN_ENV_FILE:-/opt/apps/den/secrets/.env}"
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:?--env-file needs a path}"; shift 2 ;;
    -h|--help) sed -n '3,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33mWARNING: %s\033[0m\n' "$*" >&2; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# One value from the env file, last assignment wins, surrounding quotes and a
# stray CR (file edited on Windows) stripped.
envval() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  v="${v%$'\r'}"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# ─── preflight ──────────────────────────────────────────────────────────────
# All of this runs BEFORE anything touches a container, so a misconfigured
# host fails loudly and changes nothing.

log "Preflight"
command -v docker >/dev/null || fail "docker not found on PATH"
docker compose version >/dev/null 2>&1 || fail "the docker compose plugin is not installed"
[ -f "$COMPOSE_FILE" ] || fail "compose file missing at $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || fail "env file not found at $ENV_FILE (pass --env-file, or see deploy/.env.prod.example)"

# DEN_DATA_ROOT is the guard that keeps Postgres pinned to the real data dir.
# Compose resolves relative bind mounts against the compose FILE's directory,
# and this host has two checkouts (the manual one and the runner's workspace)
# both driving the same `name: den` project — so without this, a deploy from
# the "wrong" one recreates den-postgres-1 on an EMPTY pg-data and prod looks
# wiped. See the comment block at the top of docker-compose.yml.
DATA_ROOT="$(grep -E '^DEN_DATA_ROOT=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
[ -n "$DATA_ROOT" ] || fail "DEN_DATA_ROOT is unset/empty in $ENV_FILE.
Without it, compose resolves ./pg-data relative to whichever checkout ran this
and Postgres would start on an EMPTY data dir. Set it to the absolute
directory holding the live pg-data/ — see deploy/README.md."
[ -d "$DATA_ROOT/pg-data" ] || fail "DEN_DATA_ROOT=$DATA_ROOT but $DATA_ROOT/pg-data does not exist.
Refusing to deploy onto a fresh database."

# The compose file is shared with local dev, where `${POSTGRES_PASSWORD:-den}`
# falling back to 'den' is exactly right. Production must never get there by
# accident, so the requirement lives here (prod's only deploy path) instead
# of as a `:?` in the compose file, which would break plain local
# `docker compose up`.
PG_PASS="$(envval POSTGRES_PASSWORD)"
[ -n "$PG_PASS" ] || fail "POSTGRES_PASSWORD is unset/empty in $ENV_FILE.
Compose would silently fall back to the dev default 'den'. Set it explicitly.
⚠️ It is only applied when Postgres FIRST initialises its data dir: on an
existing database it must equal the password the 'den' role already has, or
the api can no longer connect. If prod has been running on the default all
along, write POSTGRES_PASSWORD=den to make that explicit (you'll get a
warning), then rotate it properly — deploy/README.md \"Postgres password\"."
if [ "$PG_PASS" = "den" ]; then
  warn "POSTGRES_PASSWORD is the dev default 'den'. Postgres is only reachable
from this host and the compose network, but rotate it — deploy/README.md
\"Postgres password\" has the exact steps."
fi

# Pre-migration backup target: on THIS host, deliberately outside both repo
# checkouts (a dump inside one would ride along in the next docker build
# context — the same trap as deploy/pg-data, see .dockerignore).
BACKUP_DIR="${DEN_BACKUP_DIR:-$(envval DEN_BACKUP_DIR)}"
BACKUP_DIR="${BACKUP_DIR:-/opt/apps/den/backups}"
if [ "${DEN_SKIP_BACKUP:-}" = "1" ]; then
  warn "DEN_SKIP_BACKUP=1 — this deploy will run migrations WITHOUT a fresh backup."
else
  ( umask 077 && mkdir -p "$BACKUP_DIR" ) 2>/dev/null && [ -w "$BACKUP_DIR" ] \
    || fail "pre-migration backup dir $BACKUP_DIR is missing or not writable by $(id -un).
Create it once, owned by the user that deploys (the runner service user AND
whoever deploys by hand):  sudo install -d -m 700 -o \$(whoami) $BACKUP_DIR
or point DEN_BACKUP_DIR in $ENV_FILE somewhere writable OUTSIDE the repo."
fi

echo "  repo:       $REPO_ROOT"
echo "  env file:   $ENV_FILE"
echo "  data root:  $DATA_ROOT"
echo "  backup dir: $BACKUP_DIR"
echo "  commit:     $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '(not a git checkout)')"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# Container id of a service (running or not), or empty.
cid_of() { dc ps -a -q "$1" 2>/dev/null | head -1 || true; }
health_of() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$1" 2>/dev/null || true; }

# The exact command that puts the :previous images back, built from what
# compose actually names the images (`docker inspect .Config.Image`) rather
# than a guessed naming scheme. Printed on every failure and at the end.
rollback_hint() {
  local svc cid ref cmd=''
  for svc in api web; do
    cid="$(cid_of "$svc")"; [ -n "$cid" ] || continue
    ref="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"; [ -n "$ref" ] || continue
    docker image inspect "${ref%:*}:previous" >/dev/null 2>&1 || continue
    cmd+="docker tag ${ref%:*}:previous $ref && "
  done
  if [ -n "$cmd" ]; then
    printf '\n  Roll back to the previous images (code only — migrations are not undone):\n    %sdocker compose --env-file %s -f %s up -d --no-build api web\n' \
      "$cmd" "$ENV_FILE" "$COMPOSE_FILE" >&2
  else
    printf '\n  No :previous images on this host — rollback means redeploying an older commit.\n' >&2
  fi
}

# Logs + state + rollback line, then exit. Dump them inline rather than
# telling the operator to go fetch them: a crash-loop is usually a
# missing/invalid env var (env.ts's `required()` throws during module
# evaluation, so the process dies instantly and the only evidence is in these
# lines), and printing them turns an SSH round trip into an answer in the CI
# output.
fail_with_logs() {
  local svc="$1"; shift
  printf '\n\033[1;31m--- compose state ---\033[0m\n' >&2
  dc ps -a >&2 2>/dev/null || true
  printf '\n\033[1;31m--- last %s logs ---\033[0m\n' "$svc" >&2
  dc logs --tail 60 --no-color "$svc" >&2 2>/dev/null || true
  rollback_hint
  fail "$*"
}

# ─── build ──────────────────────────────────────────────────────────────────
# Build only. Nothing running is replaced yet, so a failed build (or anything
# else up to the api swap below) leaves prod exactly as it was.

log "Building images"
dc build

# ─── keep the outgoing images ───────────────────────────────────────────────
# `dc build` just moved the service tags onto the new images; the old ones
# survive only while a container uses them, and `image prune` below would
# delete them right after the swap. Tagging them :previous keeps exactly one
# rollback target per service. Only done while the outgoing api is HEALTHY:
# if a failed deploy left a broken api running, re-running the deploy must
# not overwrite the last good :previous with the broken image.
log "Tagging the running images as :previous"
api_cid="$(dc ps -q api 2>/dev/null | head -1 || true)"
if [ -z "$api_cid" ]; then
  warn "no running api container — nothing to keep as :previous (first deploy?)"
elif [ "$(health_of "$api_cid")" != "healthy" ]; then
  warn "the running api is '$(health_of "$api_cid")', not healthy — keeping the existing :previous tags"
else
  for svc in api web; do
    cid="$(dc ps -q "$svc" 2>/dev/null | head -1 || true)"
    [ -n "$cid" ] || continue
    ref="$(docker inspect -f '{{.Config.Image}}' "$cid")"
    docker tag "$(docker inspect -f '{{.Image}}' "$cid")" "${ref%:*}:previous"
    echo "  ${ref%:*}:previous <- the image $svc was running"
  done
fi

# ─── database: up, backed up, migrated — before any new code serves ─────────
# No --profile dev anywhere: that gates the MinIO stand-in, which must never
# run in prod (real R2 is configured via the env file instead).

log "Starting postgres"
dc up -d --no-build postgres
pg_cid="$(cid_of postgres)"
for i in $(seq 1 45); do
  [ "$(health_of "$pg_cid")" = "healthy" ] && break
  [ "$i" -eq 45 ] && fail_with_logs postgres "postgres never became healthy"
  sleep 2
done

if [ "${DEN_SKIP_BACKUP:-}" != "1" ]; then
  log "Backing up the database before migrating"
  # Blocking on purpose: migrations are the one step a redeploy can't undo,
  # and this dump is the undo. It needs only the postgres container (not the
  # api, not R2), so it works even when the api is down — the moment you
  # most want to ship a fix. If it truly can't run, DEN_SKIP_BACKUP=1 is the
  # conscious override.
  bash "$SCRIPT_DIR/backup.sh" --env-file "$ENV_FILE" --local "$BACKUP_DIR" \
    || fail "pre-migration backup failed — nothing was migrated or swapped; prod is untouched."
fi

log "Running database migrations (new image, one-off container)"
# `run --rm --no-deps` starts a throwaway container from the image just
# built, on the compose network, with the api's environment — while the OLD
# api keeps serving. drizzle applies all pending migrations in a single
# transaction, so a failure rolls back cleanly and leaves old code on the old
# schema, still serving: nothing to repair, just fix and redeploy. (The old
# order — swap first, migrate after — served new code on the old schema
# meanwhile, and kept serving it if the migration failed.)
# Migrations must therefore stay backward-compatible with the code that's
# still running for those seconds: add columns/tables, don't rename or drop
# in the same deploy that stops using them.
dc run --rm --no-deps -T api npm -w server run db:migrate \
  || fail "migrations failed — the previous api is still serving, on the unchanged schema."

# ─── swap the api, gate on real health ──────────────────────────────────────
log "Starting the new api (the old one may take up to 40s to drain and stop)"
# `up` stops the old container first and BLOCKS through its stop_grace_period
# (40s in docker-compose.yml: in-flight media jobs drain on SIGTERM), so the
# health clock below only starts once the new container exists. ⚠️ That
# drain is real downtime for new requests — up to ~40s plus boot.
dc up -d --no-build api

# `running` is not health: a process can be up and still unable to serve
# (bad config, DB auth, a crash on first request). Ask the app itself, from
# inside its container — the same probe as the image HEALTHCHECK, but
# immediately rather than on Docker's 30s interval.
api_health() {
  dc exec -T api node -e "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

log "Waiting for the api to pass /health"
for i in $(seq 1 60); do
  api_health && break
  [ "$i" -eq 60 ] && fail_with_logs api "the new api never passed /health within 2 minutes.
A 'Missing required env var: X' line above means X is absent from $ENV_FILE
— compare it against .env.example. Migrations HAVE been applied."
  sleep 2
done
# One healthy answer can come from a process that is about to crash-loop.
# Make sure it's the same container, not restarted, and still answering.
api_cid="$(dc ps -q api 2>/dev/null | head -1 || true)"
[ -n "$api_cid" ] || fail_with_logs api "the api container disappeared right after passing /health."
restarts="$(docker inspect -f '{{.RestartCount}}' "$api_cid")"
sleep 8
[ "$(docker inspect -f '{{.RestartCount}}' "$api_cid" 2>/dev/null || echo gone)" = "$restarts" ] && api_health \
  || fail_with_logs api "the new api answered /health once, then restarted or stopped answering. Migrations HAVE been applied."
echo "  api healthy"

# ─── swap the rest ──────────────────────────────────────────────────────────
log "Starting the rest of the stack"
# Everything else (web, plus any service whose config changed), exactly as
# the old `up -d --build` converged it — minus the build, already done.
dc up -d --no-build

# End to end: Caddy routes /health to the api. Host header = the Caddyfile's
# site address (http://den.ems-place.com); busybox wget ships in caddy:alpine.
log "Checking /health through Caddy"
for i in $(seq 1 15); do
  dc exec -T web wget -q -O /dev/null -T 5 --header 'Host: den.ems-place.com' http://127.0.0.1/health >/dev/null 2>&1 && break
  [ "$i" -eq 15 ] && fail_with_logs web "Caddy is not serving /health (bad Caddyfile? check the web logs above)."
  sleep 2
done
echo "  web healthy"

log "Pruning dangling images"
# Dangling only: the :previous tags above keep their images alive.
docker image prune -f >/dev/null

log "Done — current state"
dc ps
rollback_hint
