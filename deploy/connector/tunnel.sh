#!/usr/bin/env bash
# Runs on the PC from jakes-brain-tunnel.service: gives the Claude connector (127.0.0.1:4801,
# server/apps/connector.js) a public https address. Only that listener is forwarded; the app
# on :4800 stays LAN/tailnet-only. Settings come from ~/.config/jakes-brain/tunnel.env
# (written by setup-connector.sh, never in the repo).
set -euo pipefail
PORT=${JAKESDATA_CONNECTOR_PORT:-4801}
case "${TUNNEL:-}" in
  ngrok)
    # NGROK_AUTHTOKEN is read from the environment (kept off the command line / ps).
    exec "$HOME/.local/bin/ngrok" http "127.0.0.1:$PORT" --url "$NGROK_URL" --log stdout --log-format logfmt ;;
  cloudflare)
    # TUNNEL_TOKEN is read from the environment; the hostname -> http://localhost:4801 route
    # lives in the Cloudflare dashboard.
    exec "$HOME/.local/bin/cloudflared" tunnel --no-autoupdate run ;;
  *)
    echo "TUNNEL must be ngrok or cloudflare (see deploy/connector/README.md)" >&2
    exit 1 ;;
esac
