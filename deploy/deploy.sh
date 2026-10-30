#!/usr/bin/env bash
# Mac -> PC. Commits whatever changed and pushes to the PC; the PC's post-update hook
# restarts hq.service when server/ or deploy/ changed (web/ changes are live instantly).
# Usage: deploy/deploy.sh "what changed"
set -euo pipefail
cd "$(dirname "$0")/.."
MSG=${1:-"update $(date '+%Y-%m-%d %I:%M %p')"}
if [ -n "$(git status --porcelain)" ]; then git add -A && git commit -qm "$MSG"; fi
git push pc HEAD:main
sleep 1
curl -fsS --max-time 6 http://100.106.249.89:4800/api/version && echo
