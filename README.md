# HQ

Jake's personal iPhone app. The app on the phone is a thin native shell; everything it
shows comes from a web app + API running on the Linux PC. Edit the files on the PC and
the app updates itself within about 30 seconds. Nothing goes through the App Store.

```
iPhone  ──Tailscale (anywhere) or home WiFi──▶  PC :4800  (node server/index.js)
 HQ.app (SwiftUI + WKWebView)                   ├── web/     the UI (plain HTML/CSS/JS)
                                                ├── server/  JSON API + SQLite (~/hq-data/hq.db)
                                                └── hq.service (systemd --user, always on)
```

## What's in the app (v1)

- **Home** — the PC at a glance: uptime, load, memory, disk, and one row per service
  (reels tracker, Pocket 3 recorder, auto-vlog builder, feed accounts, Zora bot, Ollama, HQ).
- **Notes** — quick capture. Notes live in SQLite on the PC, so anything running there
  (Claude Code, Codex, a cron job) can read or write them.
- **About** — which address the phone is using, what build is deployed, and a Reload button.

## Making changes

**From the Mac** (this repo):

```bash
# edit web/ or server/, then
deploy/deploy.sh "what changed"
```

That commits and pushes to the PC. A hook on the PC restarts `hq.service` only if
`server/` or `deploy/` changed; `web/` edits are live immediately. The app notices the
new build within 30 s and reloads itself.

**On the PC directly** (`ssh pcserver`, repo at `~/hq`): edit `web/` and it is live.
After editing `server/`, run `systemctl --user restart hq`. Commit there and
`git pull pc main` on the Mac to bring the change back.

**Native shell** (`ios/`) changes need a rebuild onto the phone — see below. You will
rarely need this; put features in `web/` + `server/`.

## Putting it on the iPhone

The phone needs to reach the PC. Install **Tailscale** on the iPhone and sign in with
the same account as the Mac and PC. (Without Tailscale it works on home WiFi only.)

Plug the iPhone into the Mac (or have it on the same WiFi, previously paired), unlock it, then:

```bash
deploy/install-on-phone.sh
```

Signed with the paid developer team, so the install stays valid for a year. Re-run
after changing anything under `ios/`.

Simulator: `deploy/run-sim.sh`.

## First-time PC setup

```bash
deploy/setup-pc.sh
```

Creates `~/hq` on the PC as a push-to-deploy clone, installs the `post-update` hook and
`hq.service`, starts it, and checks `http://100.106.249.89:4800/api/health`.

## Layout and contract

`SPEC.md` is the contract between the three parts (API shapes, file layout, shell
behaviour). Read it before changing an endpoint. Data never lives in the repo: the
database is `~/hq-data/hq.db` on the PC.

## Addresses

| | |
|---|---|
| PC over Tailscale | http://100.106.249.89:4800 |
| PC on home WiFi | http://192.168.1.81:4800 |
| Health | `/api/health` · Version `/api/version` · Status `/api/status` · Notes `/api/notes` |
