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
#
# Invoked with `bash ...` rather than `./deploy.sh` on purpose: the repo is
# authored on Windows, which can't set the POSIX exec bit. The bit IS stored
# in git (`git update-index --chmod=+x`), so `./deploy/deploy.sh` works too —
# but going through `bash` means a lost exec bit can never break a deploy.
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
    -h|--help) sed -n '3,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

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

echo "  repo:      $REPO_ROOT"
echo "  env file:  $ENV_FILE"
echo "  data root: $DATA_ROOT"
echo "  commit:    $(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '(not a git checkout)')"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

# ─── deploy ─────────────────────────────────────────────────────────────────
# No --profile dev: that gates the MinIO stand-in, which must never run in
# prod (real R2 is configured via the env file instead).

log "Building and starting the stack"
dc up -d --build

# `up -d` returns once containers are *created*; the api process may still be
# booting, and `exec` against a not-yet-running container fails. Postgres is
# already gated by depends_on/service_healthy, so this is a short wait, but
# racing it produced flaky "container is not running" deploy failures.
log "Waiting for the api container to be up"
# Deliberately `compose ps -q` + `docker inspect` rather than
# `compose ps --format '{{...}}'`: Go-template support in `compose ps` varies
# across plugin versions, while `docker inspect -f` is stable everywhere.
state=''
for i in $(seq 1 30); do
  cid="$(dc ps -q api 2>/dev/null | head -1)"
  if [ -n "$cid" ]; then
    state="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null || true)"
    [ "$state" = "running" ] && break
  fi
  if [ "$i" -eq 30 ]; then
    fail "api container never reached 'running' (last state: ${state:-none}).
Check: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs api"
  fi
  sleep 2
done

log "Running database migrations"
dc exec -T api npm -w server run db:migrate

log "Pruning dangling images"
docker image prune -f >/dev/null

log "Done — current state"
dc ps
