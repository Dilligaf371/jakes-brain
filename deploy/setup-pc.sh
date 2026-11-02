#!/usr/bin/env bash
# One-time: turn ~/jakes-data-app on the PC into a push-to-deploy clone and install the systemd unit.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
PC=${JAKESDATA_PC:-pcserver}
ssh "$PC" 'set -e; mkdir -p ~/jakes-data-app ~/jakes-data-app-data ~/.config/systemd/user
  cd ~/jakes-data-app
  [ -d .git ] || git init -q -b main
  git config receive.denyCurrentBranch updateInstead
  git config user.name "jakes-data-pc"; git config user.email "jakesdata@pc"'
git remote get-url pc >/dev/null 2>&1 || git remote add pc "$PC:jakes-data-app"
git push -q pc HEAD:main
scp -q deploy/post-update "$PC:jakes-data-app/.git/hooks/post-update"
ssh "$PC" 'chmod +x ~/jakes-data-app/.git/hooks/post-update
  cp ~/jakes-data-app/deploy/jakes-data.service ~/.config/systemd/user/jakes-data.service
  systemctl --user daemon-reload
  systemctl --user enable --now jakes-data.service
  sleep 1; systemctl --user is-active jakes-data.service'
curl -fsS --max-time 6 http://100.106.249.89:4800/api/health && echo
