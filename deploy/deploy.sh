#!/usr/bin/env bash
# Mac -> GitHub -> PC. Commits what changed and pushes to main; the PC pulls it. This also asks
# the PC to pull now, so a deploy from the Mac is live in seconds. Usage: deploy/deploy-github.sh "msg"
set -euo pipefail
cd "$(dirname "$0")/.."
MSG=${1:-"update $(date '+%Y-%m-%d %I:%M %p')"}
if [ -n "$(git status --porcelain)" ]; then git add -A && git commit -qm "$MSG"; fi
git pull -q --rebase origin main
git push -q origin HEAD:main
ssh -o ConnectTimeout=5 -o BatchMode=yes pcserver 'systemctl --user start jakes-brain-pull.service' 2>/dev/null || echo "PC not reachable now; it will pull on its own"
sleep 1
curl -fsS --max-time 6 http://100.106.249.89:4800/api/version && echo
