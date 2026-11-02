#!/usr/bin/env bash
# Runs on the PC from jakes-brain-pull.timer: fast-forwards to GitHub's main and restarts the
# server only when server/ or deploy/ changed. web/ changes are live as soon as they land.
set -euo pipefail
cd "$HOME/jakes-data-app"
git fetch -q origin main
old=$(git rev-parse HEAD)
new=$(git rev-parse origin/main)
[ "$old" = "$new" ] && exit 0
git merge -q --ff-only origin/main
changed=$(git diff --name-only "$old" "$new")
echo "updated ${old:0:7} -> ${new:0:7}"
grep -qE '^(server|deploy)/' <<<"$changed" || exit 0
for f in server/*.js server/apps/*.js; do
  node --check "$f" || { echo "syntax error in $f: not restarting"; exit 1; }
done
if ! cmp -s deploy/jakes-data.service "$HOME/.config/systemd/user/jakes-data.service"; then
  cp deploy/jakes-data.service "$HOME/.config/systemd/user/jakes-data.service"
  systemctl --user daemon-reload
fi
systemctl --user restart jakes-data.service
echo "server restarted"
