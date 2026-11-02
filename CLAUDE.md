# Jake's Data — notes for agents (Claude Code / Codex)

This repo is Jake's personal app: a home-screen launcher of small apps, served by the Linux PC,
shown on his iPhone (native shell) and on the PC (browser app window). Read `README.md`, then
`SPEC.md` (the contract) before changing anything.

- **Where features go:** `web/apps/<id>/` (UI, plain HTML/CSS/JS, no build step) and
  `server/apps/<id>.js` (Node 22, zero npm dependencies, `node:sqlite`). Core files
  (`web/kit.js`, `web/launcher.js`, `web/styles.css`, `server/index.js`, `router.js`, `http.js`,
  `db.js`, `tools.js`) change rarely; prefer adding an app over editing core.
- **Smallest complete example:** `web/apps/tasks/` + `server/apps/tasks.js`.
- **Shipping:** from the Mac run `deploy/deploy.sh "message"`. On the PC (`~/jakes-data-app`),
  `web/` edits are live at once; after `server/` edits run `systemctl --user restart jakes-data`.
- **Data:** SQLite at `~/jakes-data-app-data/jakesdata.db` on the PC. Migrations are per module
  (`migrations: [{ id: '<app>-N', sql }]`); never store data inside the repo.
- **UI rules:** iPhone-like and calm. System font, light + dark, solid colours, no gradients,
  no emoji as icons, no decorative illustrations, 44px tap targets, inputs ≥ 16px. Never
  `window.confirm/alert/prompt` (the shell swallows them) — use `kit.confirmSheet`. Hold the
  auto-reload (`kit.holdReload`) while the user is typing, uploading, playing, or streaming.
- **No secrets in the repo.** The server is unauthenticated and reachable only on the home LAN
  and the tailnet; do not expose it publicly without adding auth.
- **Verify before claiming done:** `node --check` your files, start a local server
  (`JAKESDATA_PORT=4811 JAKESDATA_DATA=/tmp/jd-data JAKESDATA_CONFIG=<scratch copy of server/config.json> node server/index.js`),
  curl the routes, and look at the UI at 390×844 (Playwright at
  `~/.pyenv/versions/devika_python_virtual_env/bin/python`, `channel="chrome"`). For `ios/` run
  `deploy/run-sim.sh`.
