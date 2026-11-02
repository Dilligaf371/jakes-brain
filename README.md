# Jake's Brain

Jake's personal app. On the iPhone it is a thin native shell; on the Linux PC it is a
chromeless browser window. Both show the same web app served by the PC, so editing the files
on the PC changes the app everywhere within about 30 seconds. Nothing goes through the App Store.

```
iPhone (JakesData.app, WKWebView) ──Tailscale / home WiFi──▶  PC :4800  node server/index.js
PC desktop window (Brave --app)   ──localhost──────────────▶   ├── web/      launcher + apps (plain HTML/CSS/JS)
                                                               ├── server/   JSON API + SQLite + media
                                                               └── jakes-data.service (systemd --user)
```

## What's inside

The first screen is a home screen: a grid of tiles plus a dock. Each tile is one of Jake's own apps:

| app | what it is |
|---|---|
| Notes | title + body notes with autosave, search, pin, `#tags` and `[[links]]` |
| Tasks | checklist (open / done), badge on the tile |
| Calendar | month grid, day agenda, events |
| Jakestagram | private Instagram: post photos and videos from the phone, feed + grid, hearts |
| JakeTube | private YouTube over the PC's videos (daily auto-vlogs, raw Pocket 3, game captures) |
| JakeGPT | private ChatGPT on the PC's Ollama, streaming, conversations saved |
| Habits | daily check-ins, streaks, 7-day strip |
| Files | read-only browser of PC folders with previews |
| Weather | Open-Meteo forecast for a chosen city |
| Reels | today's proposed reels, hook ideas and top performers from the reels tracker |
| Deals | brand deals, deliverables, invoices and what's owed; due dates appear in Calendar |
| People | contact list; `@handle` in any note or deal links that person in the Graph |
| Saved | paste a link and the PC stores the page text for searchable read-later |
| Voice Memos | record in the iPhone shell or add an audio file; Whisper transcribes it into Notes |
| Focus | countdown timer that logs sessions, with a weekly total |
| Day Log | searchable timeline of each day from the auto-vlog transcripts |
| Bots | read-only status of the Zora bot and feed accounts |
| Graph | Obsidian-style graph of everything above, linked by day, tag, note links and @mentions |
| Server | the PC at a glance: uptime, load, memory, disk, one row per service |
| Settings | address in use, deployed build, Reload, per-app settings |

## Making changes

**From the Mac** (this repo, `~/jakes-data-app`):

```bash
deploy/deploy.sh "what changed"
```

Commits and pushes to the PC. A hook there restarts `jakes-data.service` only if `server/` or
`deploy/` changed; `web/` edits are live immediately. The phone and the desktop window reload
themselves when the build changes.

**On the PC directly** (`ssh pcserver`, repo at `~/jakes-data-app`): edit `web/` and it is live;
after editing `server/` run `systemctl --user restart jakes-data`. Commit there and
`git pull pc main` on the Mac.

**Adding an app:** add an entry to `web/apps.json`, create `web/apps/<id>/index.js` (export
`{ mount(root, ctx), unmount(), route(sub) }`) and `styles.css` (every selector prefixed
`.app-<id>`), an icon `web/icons/app-<id>.svg`, and, if it needs data, `server/apps/<id>.js`
(export `{ id, migrations, register(r, ctx) }`). The server picks modules up on restart; the
launcher picks tiles up on reload. `SPEC.md` has the full contract and `web/apps/tasks/` plus
`server/apps/tasks.js` are the smallest complete example.

**Native shell** (`ios/`): rarely needed. Plug the phone in, unlock it, and run
`deploy/install-on-phone.sh`. Simulator: `deploy/run-sim.sh`.

## Desktop version (on the PC)

```bash
deploy/desktop/install-desktop.sh      # once: adds "Jake's Brain" to the GNOME app grid
deploy/desktop/open.sh graph           # opens a window straight to the Graph
```

The window is Brave in app mode pointed at `http://localhost:4800`, so it is the same app.

## First-time PC setup

```bash
deploy/setup-pc.sh
```

## Where things live

| | |
|---|---|
| PC over Tailscale | http://100.106.249.89:4800 |
| PC on home WiFi | http://192.168.1.81:4800 |
| Database | `~/jakes-data-app-data/jakesdata.db` on the PC (never in the repo) |
| Uploads | `~/jakes-data-app-data/media/<app>/` |
| Thumbnails (regenerable) | `~/jakes-data-app-data/cache/<app>/` |
| Core API | `/api/health` · `/api/version` · `/api/status` · `/api/settings` · `/api/apps` |
| App APIs | `/api/<app>/…` (see SPEC.md) |
