#!/usr/bin/env bash
#
# Den — failure alert for a systemd unit (wired to den-backup.service via
# OnFailure=den-backup-alert.service). OPT-IN: with neither variable below set
# in the env file this logs one line and exits 0, i.e. it is a no-op.
#
#   DEN_ALERT_URL=https://ntfy.sh/<your-private-topic>
#       POSTs the alert as a plain-text body (ntfy, healthchecks.io "/fail"
#       URLs and similar accept that as-is). Needs `curl` on the host.
#   DEN_ALERT_CMD=/usr/local/bin/my-notifier
#       Runs that command via `bash -c`, with the alert text on stdin and in
#       $DEN_ALERT_MESSAGE — for anything that needs its own payload format
#       (Discord/Slack JSON, mail, ...). Runs as root, like the backup itself.
#
# Both may be set; each is attempted, and the script fails if any attempt
# fails (so a broken alert path shows up in `systemctl --failed` too).
#
# Usage (normally only from systemd):
#   bash deploy/alert.sh <failed-unit-name>
#   DEN_ENV_FILE=/path/.env bash deploy/alert.sh den-backup.service   # test it
set -euo pipefail

UNIT="${1:-unknown unit}"
ENV_FILE="${DEN_ENV_FILE:-/opt/apps/den/secrets/.env}"

envval() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  v="${v%$'\r'}"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

URL="$(envval DEN_ALERT_URL)"
CMD="$(envval DEN_ALERT_CMD)"

if [ -z "$URL" ] && [ -z "$CMD" ]; then
  echo "den alert: $UNIT failed, but no DEN_ALERT_URL / DEN_ALERT_CMD is set in $ENV_FILE — not notifying"
  exit 0
fi

# The last log lines turn "backup failed" into an answer. journalctl exists on
# any host that runs these units; still never let it block the alert itself.
LOGS="$(journalctl -u "$UNIT" -n 15 --no-pager -o cat 2>/dev/null || true)"
DEN_ALERT_MESSAGE="Den: $UNIT FAILED on $(hostname) at $(date -u '+%Y-%m-%d %H:%M UTC').
Check: journalctl -u $UNIT -n 50

${LOGS:-(no journal output available)}"
export DEN_ALERT_MESSAGE

status=0
if [ -n "$URL" ]; then
  if ! command -v curl >/dev/null; then
    echo "den alert: DEN_ALERT_URL is set but curl is not installed" >&2
    status=1
  elif ! printf '%s\n' "$DEN_ALERT_MESSAGE" | curl -fsS -m 15 --data-binary @- "$URL" >/dev/null; then
    echo "den alert: POST to DEN_ALERT_URL failed" >&2
    status=1
  fi
fi
if [ -n "$CMD" ]; then
  if ! printf '%s\n' "$DEN_ALERT_MESSAGE" | bash -c "$CMD"; then
    echo "den alert: DEN_ALERT_CMD exited non-zero" >&2
    status=1
  fi
fi
exit "$status"
