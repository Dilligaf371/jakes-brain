# Jake's Brain — notes for agents (Claude Code / Codex)

This repo is Jake's personal app: a home-screen launcher of small apps, served by the Linux PC,
shown on his iPhone (native shell) and on the PC (browser app window). Read `README.md`, then
`SPEC.md` (the contract) before changing anything.

- **Where features go:** `web/apps/<id>/` (UI, plain HTML/CSS/JS, no build step) and
  `server/apps/<id>.js` (Node 22, zero npm dependencies, `node:sqlite`). Core files
  (`web/kit.js`, `web/launcher.js`, `web/styles.css`, `server/index.js`, `router.js`, `http.js`,
  `db.js`, `tools.js`) change rarely; prefer adding an app over editing core.
- **Smallest complete example:** `web/apps/tasks/` + `server/apps/tasks.js`.
- **Shipping (this is the important one):** commit and push, nothing else. Anything pushed to `main`
  or a `claude/*` branch goes live on its own: a GitHub Action merges `claude/*` into `main`, the
  PC pulls `main` about every 45 seconds, and the phone and desktop reload themselves within 30
  seconds. Do not open a pull request. From the Mac, `deploy/deploy.sh "message"` does the same,
  faster. Never edit files on the PC directly: its copy only fast-forwards, so a local edit blocks
  every later update.
- **Mobile and cloud sessions** cannot reach the PC. They cannot build the iOS shell, so `ios/`
  changes wait for the Mac. Test with a local server, then push.
- **Data:** SQLite at `~/jakes-data-app-data/jakesdata.db` on the PC. Migrations are per module
  (`migrations: [{ id: '<app>-N', sql }]`); never store data inside the repo.
- **UI rules:** iPhone-like and calm. System font, light + dark, solid colours, no gradients,
  no emoji as icons, no decorative illustrations, 44px tap targets, inputs ≥ 16px. Never
  `window.confirm/alert/prompt` (the shell swallows them) — use `kit.confirmSheet`. Hold the
  auto-reload (`kit.holdReload`) while the user is typing, uploading, playing, or streaming.
- **No secrets in the repo.** The main server :4800 stays private (LAN/tailnet). Never tunnel it.
  The public HTTPS tunnel targets only 127.0.0.1:4801: `connector.js` preserves MCP OAuth and
  `_app_gateway.js` protects app pages, APIs and media with device sessions. The phone uses this
  public URL and must never require Tailscale or home Wi-Fi. Keep password changes and pairing-token
  creation private; never put secrets in URLs, logs or git. App and MCP credentials are separate.
  Claude discovers new abilities through `app_catalog`, `app_read` and `app_write`; document routes
  in each module's header. Respect DENY and READ_ONLY for management and real-money routes.
- **Verify before claiming done:** `node --check` your files, start a local server
  (`JAKESDATA_PORT=4811 JAKESDATA_DATA=/tmp/jd-data JAKESDATA_CONFIG=<scratch copy of server/config.json> node server/index.js`),
  curl the routes, and look at the UI at 390×844 (Playwright at
  `~/.pyenv/versions/devika_python_virtual_env/bin/python`, `channel="chrome"`). For `ios/` run
  `deploy/run-sim.sh`.
