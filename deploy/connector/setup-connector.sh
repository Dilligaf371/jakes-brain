#!/usr/bin/env bash
# One-time, from the Mac: put the Claude connector on the internet through a tunnel, so Claude
# (the app, claude.ai, Claude Code) can use Jake's Brain the way it uses Notion.
#
#   deploy/connector/setup-connector.sh ngrok <authtoken> <name.ngrok-free.app>
#   deploy/connector/setup-connector.sh cloudflare <tunnel-token> <brain.yourdomain.com>
#
# Installs the tunnel program in ~/.local/bin on the PC (no sudo), stores the token in
# ~/.config/jakes-brain/tunnel.env (mode 600), starts jakes-brain-tunnel.service, saves the
# public address in the app, and prints the URL to paste into Claude. Safe to re-run.
set -euo pipefail
PC=${JAKESDATA_PC:-pcserver}
kind=${1:-}; token=${2:-}; host=${3:-}
host=${host#https://}; host=${host%%/*}
if [[ ! "$kind" =~ ^(ngrok|cloudflare)$ || -z "$token" || -z "$host" ]]; then
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

if [ "$kind" = ngrok ]; then
  env_file="TUNNEL=ngrok
NGROK_AUTHTOKEN=$token
NGROK_URL=https://$host"
else
  env_file="TUNNEL=cloudflare
TUNNEL_TOKEN=$token"
fi

# The token goes over ssh stdin, never on a command line.
printf '%s\n' "$env_file" | ssh "$PC" 'set -e; umask 077; mkdir -p ~/.config/jakes-brain; cat > ~/.config/jakes-brain/tunnel.env'

ssh "$PC" KIND="$kind" HOST="$host" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p ~/.local/bin ~/.config/systemd/user
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported CPU $(uname -m)"; exit 1 ;; esac
if [ "$KIND" = ngrok ] && [ ! -x ~/.local/bin/ngrok ]; then
  echo "installing ngrok"
  curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-$arch.tgz" | tar -xz -C ~/.local/bin ngrok
fi
if [ "$KIND" = cloudflare ] && [ ! -x ~/.local/bin/cloudflared ]; then
  echo "installing cloudflared"
  curl -fsSL -o ~/.local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
  chmod +x ~/.local/bin/cloudflared
fi
cd ~/jakes-data-app
if ! curl -fsS --max-time 5 http://127.0.0.1:4800/api/connector >/dev/null; then
  echo "The PC is not running the connector yet. Wait a minute for it to pull the latest code, then re-run."
  exit 1
fi
cp deploy/connector/jakes-brain-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable jakes-brain-tunnel.service >/dev/null
systemctl --user restart jakes-brain-tunnel.service
# Keep user services running while nobody is logged in (no-op if already on).
loginctl enable-linger "$USER" 2>/dev/null || true
curl -fsS --max-time 5 -X PATCH -H 'Content-Type: application/json' \
  -d "{\"connector.publicUrl\":\"https://$HOST\"}" http://127.0.0.1:4800/api/settings >/dev/null
sleep 4
systemctl --user is-active --quiet jakes-brain-tunnel.service || {
  echo "The tunnel did not start. Last lines of its log:"; journalctl --user -u jakes-brain-tunnel.service -n 20 --no-pager; exit 1; }
url=$(curl -fsS http://127.0.0.1:4800/api/connector | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' "$url" || true)
echo
if [ "$code" = 200 ]; then echo "Tunnel works (the public URL answered)."; else echo "Warning: the public URL answered $code; check the tunnel log: journalctl --user -u jakes-brain-tunnel -f"; fi
echo
echo "Paste this into Claude → Settings → Connectors → Add custom connector:"
echo "  $url"
echo "It is also in Jake's Brain → Settings → Claude connector."
REMOTE
