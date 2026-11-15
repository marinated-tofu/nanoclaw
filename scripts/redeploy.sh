#!/usr/bin/env bash
# Deploys origin/<branch> to this install: fast-forward, install if the
# lockfile changed, build, restart the service and check it answers. If any
# step fails it goes back to the commit that was running and rebuilds that.
#
#   scripts/redeploy.sh <systemd user service>    e.g. nanoclaw-v2-6710e89e
#
# Run it from a systemd user timer (see scripts/redeploy.timer.example) so a
# merge to main is live a minute or two later. It never touches a checkout
# with uncommitted changes or local commits that are not on origin.
set -uo pipefail

cd "$(dirname "$0")/.."
SERVICE=${1:?usage: scripts/redeploy.sh <systemd user service>}
BRANCH=${REDEPLOY_BRANCH:-main}
PORT=${NANOCLAW_LOCAL_WEB_PORT:-3210}
LOG=${REDEPLOY_LOG:-data/redeploy.log}
mkdir -p "$(dirname "$LOG")"

log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

exec 9>"${TMPDIR:-/tmp}/nanoclaw-redeploy-$SERVICE.lock"
flock -n 9 || exit 0

git fetch -q origin "$BRANCH" || { log "fetch failed"; exit 1; }
old=$(git rev-parse HEAD)
new=$(git rev-parse "origin/$BRANCH")
[ "$old" = "$new" ] && [ "${FORCE:-0}" != 1 ] && exit 0

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "skipped $new: the checkout has uncommitted changes"
  exit 1
fi
if ! git merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  log "skipped $new: HEAD has commits that are not on origin/$BRANCH"
  exit 1
fi

build() {
  # $1: the commit the dependencies were last installed for.
  if ! git diff --quiet "$1" HEAD -- package.json pnpm-lock.yaml; then
    pnpm install --frozen-lockfile >>"$LOG" 2>&1 || return 1
  fi
  node node_modules/typescript/bin/tsc >>"$LOG" 2>&1 || return 1
  # The startup tripwire refuses code that no sanctioned path recorded;
  # this deploy is one, so record it (docs/upgrade-recovery.md).
  node node_modules/tsx/dist/cli.mjs scripts/upgrade-state.ts set '' redeploy >>"$LOG" 2>&1
}

healthy() {
  systemctl --user restart "$SERVICE" || return 1
  for _ in $(seq 1 20); do
    sleep 1
    curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null && systemctl --user is-active -q "$SERVICE" && return 0
  done
  return 1
}

git merge -q --ff-only "origin/$BRANCH"
log "deploying $(git log --oneline -1 HEAD)"
if build "$old" && healthy; then
  log "deployed $new"
  exit 0
fi

log "deploy of $new failed; going back to $old"
git reset -q --hard "$old"
if build "$new" && healthy; then
  log "rolled back to $old"
else
  log "rollback to $old did not come up healthy; check the service"
fi
exit 1
