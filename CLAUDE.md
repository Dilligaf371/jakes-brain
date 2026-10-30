# HQ — notes for agents (Claude Code / Codex)

This repo is Jake's personal iPhone app. Read `README.md` and `SPEC.md` first.

- **Where features go:** `web/` (UI, plain HTML/CSS/JS, no build step) and `server/`
  (Node 22, zero npm dependencies, `node:sqlite`). Avoid touching `ios/` unless the
  change truly needs native code; native changes require `deploy/install-on-phone.sh`
  with the phone connected.
- **Shipping:** from the Mac run `deploy/deploy.sh "message"`. On the PC (`~/hq`),
  edits to `web/` are live at once; after `server/` edits run `systemctl --user restart hq`.
- **Data:** SQLite at `~/hq-data/hq.db` on the PC. Add migrations in `server/db.js`;
  never store data inside the repo.
- **Keep the design calm:** system font, light + dark, no gradients, no emoji as icons,
  no decorative illustrations. One row per thing. Jake rejects AI-looking UI.
- **No secrets in the repo.** The server is unauthenticated and reachable only on the
  home LAN and the tailnet; do not expose it publicly without adding auth.
- Verify before claiming done: `node --check server/*.js`, start the server locally
  (`HQ_PORT=4811 HQ_DATA=/tmp/hq-data node server/index.js`) and curl the endpoints;
  for `ios/` run `deploy/run-sim.sh`.
