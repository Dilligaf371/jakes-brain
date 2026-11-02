#!/usr/bin/env bash
# One-time, run by Jake on the Mac: creates the PRIVATE GitHub repo, pushes the code, gives the PC
# a read-only key, starts the PC's auto-pull, then proves the whole path with an empty test commit.
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER=$(gh api user --jq .login)
REPO="$OWNER/jakes-brain"
gh repo view "$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --private --description "Jake's Brain: personal app"
[ "$(gh repo view "$REPO" --json visibility --jq .visibility)" = "PRIVATE" ] || { echo "Repo is not private. Stopping."; exit 1; }
# The Mac signs in through gh, not SSH. This applies to this repo only.
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
git remote set-url origin "https://github.com/$REPO.git"
git config --local --replace-all credential.helper ''
git config --local --add credential.helper '!gh auth git-credential'
git push -q -u origin main
echo "1/4 code pushed to private repo $REPO"

PUB=$(ssh -o BatchMode=yes pcserver 'set -e; [ -f ~/.ssh/jakes-brain-deploy ] || ssh-keygen -q -t ed25519 -N "" -C jakes-brain-pc -f ~/.ssh/jakes-brain-deploy; cat ~/.ssh/jakes-brain-deploy.pub')
gh api "repos/$REPO/keys" --jq '.[].key' | grep -qF "${PUB% *}" || gh api "repos/$REPO/keys" -f title="PC (read-only)" -f key="$PUB" -F read_only=true >/dev/null
echo "2/4 PC has a read-only key"

ssh -o BatchMode=yes pcserver "set -e; cd ~/jakes-data-app
  git config core.sshCommand 'ssh -i ~/.ssh/jakes-brain-deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
  git remote get-url origin >/dev/null 2>&1 || git remote add origin git@github.com:$REPO.git
  git fetch -q origin main && git merge -q --ff-only origin/main
  cp deploy/jakes-brain-pull.service deploy/jakes-brain-pull.timer ~/.config/systemd/user/
  rm -f .git/hooks/post-update
  systemctl --user daemon-reload
  systemctl --user enable --now jakes-brain-pull.timer >/dev/null 2>&1
  systemctl --user restart jakes-data.service"
mv deploy/deploy-github.sh deploy/deploy.sh
git add -A && git commit -qm "Deploy through GitHub" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push -q origin main
git remote remove pc 2>/dev/null || true
echo "3/4 PC auto-pull is on"

BRANCH="claude/connection-test"
git checkout -q -b "$BRANCH"
git commit -q --allow-empty -m "Connection test" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
SHA=$(git rev-parse --short HEAD)
git push -q origin "$BRANCH"
git checkout -q main
START=$SECONDS
echo "4/4 testing the same path a phone edit takes (up to 4 minutes)..."
while [ $((SECONDS - START)) -lt 240 ]; do
  if git fetch -q origin main && git merge-base --is-ancestor "$SHA" origin/main; then
    HEAD=$(git rev-parse --short origin/main)
    case "$(curl -fsS --max-time 5 http://100.106.249.89:4800/api/version || true)" in
      *"\"build\":\"$HEAD"*) git pull -q --ff-only origin main; git push -q origin --delete "$BRANCH"; git branch -qD "$BRANCH"
        echo "WORKED: live on the PC $((SECONDS - START)) seconds after the push"; exit 0;; esac
  fi
  sleep 5
done
echo "TIMED OUT: check the Actions tab at https://github.com/$REPO/actions"; exit 1
