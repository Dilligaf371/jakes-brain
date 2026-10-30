#!/usr/bin/env bash
# One-time: turn ~/hq on the PC into a push-to-deploy clone and install the systemd unit.
# Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
PC=${HQ_PC:-pcserver}
ssh "$PC" 'set -e; mkdir -p ~/hq ~/hq-data ~/.config/systemd/user
  cd ~/hq
  [ -d .git ] || git init -q -b main
  git config receive.denyCurrentBranch updateInstead
  git config user.name "hq-pc"; git config user.email "hq@pc"'
git remote get-url pc >/dev/null 2>&1 || git remote add pc "$PC:hq"
git push -q pc HEAD:main
scp -q deploy/post-update "$PC:hq/.git/hooks/post-update"
ssh "$PC" 'chmod +x ~/hq/.git/hooks/post-update
  cp ~/hq/deploy/hq.service ~/.config/systemd/user/hq.service
  systemctl --user daemon-reload
  systemctl --user enable --now hq.service
  sleep 1; systemctl --user is-active hq.service'
curl -fsS --max-time 6 http://100.106.249.89:4800/api/health && echo
