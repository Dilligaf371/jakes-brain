# HQ — personal iPhone app, backend on the Linux PC

HQ is Jake's personal iPhone app. It is a thin native shell (SwiftUI + WKWebView)
around a web app + JSON API that run on his Linux PC. Editing `web/` or `server/`
on the PC changes the app with no rebuild; only `ios/` changes need Xcode.

## Hosts and addresses (facts, do not invent others)

| thing | value |
|---|---|
| PC hostname | jacob-beauchamp-MS-7C02 (Ubuntu, kernel 7.0) |
| PC Tailscale IP | 100.106.249.89 |
| PC LAN IP | 192.168.1.81 |
| PC ssh alias (from the Mac) | `pcserver` (user jacob-beauchamp) |
| PC node | /home/jacob-beauchamp/.nvm/versions/node/v22.23.3/bin/node (v22.23.3) |
| PC repo path | /home/jacob-beauchamp/hq |
| PC data dir | /home/jacob-beauchamp/hq-data (SQLite lives here, NOT in the repo) |
| Server port | 4800 |
| Mac repo path | /Users/jacobbeauchamp/hq |
| iOS bundle id | com.jakebeau.hq |
| Apple team | 3VTHP9BHH6 (paid, Individual) |
| Jake's iPhone UDID | 00008150-00062DD41408401C (iPhone 17 Pro) |

Base URLs the phone tries, in order: `http://100.106.249.89:4800` (Tailscale, works
anywhere once Tailscale is on the phone) then `http://192.168.1.81:4800` (home WiFi).

## Repo layout

```
hq/
  SPEC.md            this file (the contract)
  README.md          human docs: what it is, how to update, how to install on the phone
  CLAUDE.md          agent-facing rules (AGENTS.md is the same file for Codex)
  server/            Node 22, ZERO npm dependencies (node:http, node:sqlite, node:fs, node:child_process)
    index.js         entry: static files from ../web + /api routes
    db.js            node:sqlite (DatabaseSync) open + migrations
    api.js           route handlers
    status.js        machine + service status collection
    config.json      services to show on Home (see below)
  web/               plain HTML/CSS/JS, NO build step, mobile-first (390px), dark+light
    index.html  app.js  styles.css  manifest.webmanifest  icons/
  ios/               xcodegen project (project.yml) -> HQ.xcodeproj (generated, gitignored)
    HQ/              Swift sources + Assets.xcassets + Info.plist
  deploy/
    hq.service       systemd --user unit for the PC
    deploy.sh        Mac -> PC: commit + git push to the PC, hook restarts the service
    install-on-phone.sh   xcodegen + xcodebuild + devicectl install onto Jake's iPhone
    run-sim.sh       build + run in the booted simulator
```

## Server (server/)

- Entry `node server/index.js`. Env: `HQ_PORT` (default 4800), `HQ_DATA` (default
  `$HOME/hq-data`), `HQ_WEB` (default `<repo>/web`), `HQ_BIND` (default `0.0.0.0`).
- Creates `HQ_DATA` if missing; DB file `HQ_DATA/hq.db` via `node:sqlite`
  `DatabaseSync` (available unflagged on Node 22.23). WAL mode. Migrations table.
- Static: serves files under `HQ_WEB`. `Cache-Control: no-store` for `.html .js .css
  .webmanifest .json`; `public, max-age=86400` for icons/images. Unknown non-/api path
  -> `index.html` (SPA). Path traversal rejected.
- JSON API, all responses `application/json; charset=utf-8`. Errors: `{ "error":
  "message" }` with 4xx/5xx. CORS: allow `*` (the web app may be opened from the
  Mac during dev). Request bodies JSON, max 64 KB.
- Logs one line per request to stdout: `METHOD path status ms`.

### Endpoints

| method+path | behaviour |
|---|---|
| `GET /api/health` | `{ ok: true, name: "hq", host: <hostname>, time: <ISO> }` fast, no shelling out |
| `GET /api/version` | `{ build: <string>, started: <ISO>, node: <process.version> }`. `build` = short git sha of the repo if `git rev-parse --short HEAD` works (cached 10 s), else the max mtime (ms) of files under `web/` as a string. **Web app polls this; when `build` changes it reloads.** So `build` MUST also change when `web/` files change without a commit: final `build` = `${gitsha or 'nogit'}-${maxMtimeOfWeb}`. |
| `GET /api/status` | machine + services, see shape below. Must complete < 1.5 s; each systemctl call has a 1 s timeout; never throws, missing pieces are `null`. |
| `GET /api/notes` | `{ notes: [Note] }` ordered: open first (newest first), then done (newest first) |
| `POST /api/notes` | body `{ text }` (trimmed, 1..2000 chars) -> `201 { note: Note }` |
| `PATCH /api/notes/:id` | body `{ text?, done? }` -> `{ note: Note }`; 404 if missing |
| `DELETE /api/notes/:id` | `204`; 404 if missing |

`Note = { id: number, text: string, done: boolean, created_at: ISO, updated_at: ISO }`

`GET /api/status` shape:
```json
{
  "host": "jacob-beauchamp-MS-7C02",
  "time": "2026-10-30T18:00:00.000Z",
  "uptime_s": 123456,
  "load": [0.5, 0.4, 0.3],
  "mem": { "total": 67000000000, "used": 21000000000 },
  "disk": { "path": "/", "total": 490000000000, "used": 410000000000 },
  "addresses": { "tailscale": "100.106.249.89", "lan": "192.168.1.81" },
  "services": [
    { "unit": "pocket3-vlog.service", "label": "Pocket 3 recorder", "active": "active", "since": "2026-10-29T..." }
  ]
}
```
- `uptime_s`, `load`, `mem` from `node:os`. `disk` from `fs.statfs('/')`.
- `addresses` from `os.networkInterfaces()`: tailscale = first IPv4 starting `100.`
  on an interface named `tailscale*`; lan = first non-internal IPv4 on another iface.
- `services` = the list in `server/config.json`, each queried with
  `systemctl --user show <unit> -p ActiveState -p ActiveEnterTimestamp` (fall back to
  system scope for units with `"scope": "system"`). `active` is one of
  `active | inactive | failed | activating | deactivating | unknown`. On the Mac (no
  systemctl) every service is `unknown` and the endpoint still returns 200.

`server/config.json`:
```json
{
  "services": [
    { "unit": "boost-tracker.service",    "label": "Reels tracker" },
    { "unit": "boost-tracker-yt.service", "label": "YouTube ingest" },
    { "unit": "pocket3-vlog.service",     "label": "Pocket 3 recorder" },
    { "unit": "pocket3-autovlog.service", "label": "Auto-vlog builder" },
    { "unit": "feed-accounts.service",    "label": "Feed accounts" },
    { "unit": "zora-bot.service",         "label": "Zora bot" },
    { "unit": "ollama.service",           "label": "Ollama" },
    { "unit": "hq.service",               "label": "HQ (this app)" }
  ]
}
```

## Web app (web/)

- Files: `index.html`, `app.js`, `styles.css`, `manifest.webmanifest`,
  `icons/icon-180.png`, `icons/icon-512.png`, `icons/favicon.png` (icons already exist).
- No framework, no bundler, ES2020 modules are fine. Must look right at 390x844 with
  the iPhone notch (`viewport-fit=cover`, pad with `env(safe-area-inset-*)`).
  `<meta name="apple-mobile-web-app-capable" content="yes">`, status bar
  `black-translucent`, theme-color matching the background in both schemes.
- Design: calm and plain. System font stack (`-apple-system, ...`). Light + dark via
  `prefers-color-scheme`. No gradients, no emoji as icons, no decorative illustration.
  Bottom tab bar with three tabs: **Home**, **Notes**, **About**. Tabs are plain text
  labels with a small SF-Symbol-like inline SVG (simple strokes) — keep it minimal.
- **Home**: a compact machine card (host, uptime like "3d 4h", load, mem used/total in
  GB, disk used/total with a thin bar) then **one row per service**: status dot
  (green active, grey inactive/unknown, red failed, amber activating), label, and the
  since-time as relative ("2d", "4h", "12m") on the right. Pull the list from
  `/api/status` on open, on tab switch, every 30 s while visible, and on
  `hq:foreground`. Show a subtle "updated 12s ago" line.
- **Notes**: a single-line input at the top with an Add button (Enter also adds);
  list of notes; tapping the round checkbox toggles `done` (done notes go to a
  "Done" section below, struck through, muted); a small "×" on each row deletes
  after a quick confirm (`confirm()` is fine). Optimistic updates; on failure revert
  and show a toast. Empty state text: "Nothing here yet."
- **About**: server base URL in use, `build` from `/api/version`, server start time,
  native shell version (from `window.HQ.version` if present, else "web"), a
  "Reload" button, and a short "How to update" blurb: *Edit `web/` or `server/` in
  `~/hq` on the PC (or run `deploy/deploy.sh` from the Mac). The app refreshes itself
  within 30 seconds.*
- **Live update**: poll `/api/version` every 30 s (and on `hq:foreground`); if `build`
  differs from the one loaded with the page, `location.reload()`.
- **Unreachable**: if a fetch fails, show a thin top banner "Can't reach the PC —
  retrying…" and keep retrying with backoff (2s, 4s, 8s, max 30s). Never a blank page.
- Native bridge (optional, feature-detect): `window.HQ` is injected by the iOS shell:
  `{ native: true, version: "1.0 (1)" }`. To buzz:
  `window.webkit?.messageHandlers?.native?.postMessage({ type: "haptic", style: "light" | "medium" | "success" | "error" })`.
  Call it on note toggle (light) and add (success). Guard everything; on the Mac
  `window.HQ` is undefined.
- All API calls are relative (`/api/...`) — the page is always served by the same
  server, so no base URL config in the web app.

## iOS shell (ios/)

- `ios/project.yml` (xcodegen 2.46): name `HQ`, bundleIdPrefix `com.jakebeau`,
  deploymentTarget iOS 17.0, one target `HQ` (application, iOS), sources `HQ`,
  settings: `PRODUCT_BUNDLE_IDENTIFIER com.jakebeau.hq`, `GENERATE_INFOPLIST_FILE YES`,
  `INFOPLIST_KEY_CFBundleDisplayName HQ`, `INFOPLIST_KEY_UILaunchScreen_Generation YES`,
  `INFOPLIST_KEY_UIApplicationSceneManifest_Generation YES`,
  `INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone UIInterfaceOrientationPortrait`,
  `ASSETCATALOG_COMPILER_APPICON_NAME AppIcon`,
  `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME AccentColor`,
  `TARGETED_DEVICE_FAMILY "1"`, `SWIFT_VERSION "5.0"`, `CURRENT_PROJECT_VERSION 1`,
  `MARKETING_VERSION "1.0"`, `CODE_SIGN_STYLE Automatic`, `DEVELOPMENT_TEAM 3VTHP9BHH6`.
  Info properties: `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }` (plain
  http to private IPs — personal app, not for the App Store),
  `ITSAppUsesNonExemptEncryption: false`.
- Files in `ios/HQ/`:
  - `HQApp.swift` — `@main`, `WindowGroup { RootView() }`, watches `scenePhase`.
  - `Config.swift` — `enum Config { static let candidates: [URL] = [tailscale, lan];
    static let healthPath = "/api/health"; static let healthTimeout: TimeInterval = 2.5 }`
    plus a `UserDefaults` override key `hq.baseURL` (string) that, if set, is tried first.
  - `ServerLocator.swift` — `actor` or `final class`: `func locate() async -> URL?`:
    tries the last-good URL first (UserDefaults `hq.lastGoodURL`), then races all
    candidates with `URLSession` GETs to `/api/health` (timeout `Config.healthTimeout`,
    `cachePolicy .reloadIgnoringLocalCacheData`); first 200 whose JSON has `ok == true`
    wins; store as last-good. Returns nil if none.
  - `RootView.swift` — state machine `enum Phase { case locating, loaded(URL), unreachable([URL]) }`.
    `locating` shows a plain ProgressView with "Finding the PC…". `loaded` shows
    `WebShell(url:)`. `unreachable` shows `UnreachableView` (title "Can't reach the PC",
    the addresses tried, one-line hint "Join Tailscale on this phone or connect to home
    WiFi.", a Retry button). On `scenePhase == .active` after being in background:
    if phase is `.loaded`, post `hq:foreground` into the page via
    `evaluateJavaScript("window.dispatchEvent(new Event('hq:foreground'))")`; if
    `.unreachable`, retry locate.
  - `WebShell.swift` — `UIViewRepresentable` around `WKWebView`:
    `WKWebViewConfiguration` with `userContentController` adding a script message
    handler named `native` (messages `{type:"haptic", style}` -> `UIImpactFeedbackGenerator`
    / `UINotificationFeedbackGenerator`) and a `WKUserScript` at document start
    injecting `window.HQ = { native: true, version: "<MARKETING_VERSION> (<BUILD>)" }`
    read from `Bundle.main.infoDictionary`. `allowsBackForwardNavigationGestures =
    false`, `scrollView.contentInsetAdjustmentBehavior = .never` (the web app handles
    safe areas), `isOpaque = false`, `backgroundColor = .systemBackground`,
    `scrollView.bounces = true`, `isInspectable = true` (iOS 16.4+, lets Safari on the
    Mac inspect the page). `UIRefreshControl` on `scrollView` → `reload()`.
    Navigation delegate: main-frame navigations to a different host than the base URL,
    or `target=_blank` (`navigationAction.targetFrame == nil`), open in Safari via
    `UIApplication.shared.open` and cancel. `didFailProvisionalNavigation` with a
    network error → the coordinator reports up so `RootView` goes `.unreachable`
    (ignore `NSURLErrorCancelled`). The web view ignores the system font size
    multiplier? No — leave default.
  - `UnreachableView.swift` — SwiftUI, system styling only.
  - `Assets.xcassets/` — `AppIcon.appiconset` (single 1024 universal `icon-1024.png`,
    already provided at `ios/HQ/Assets.xcassets/AppIcon.appiconset/icon-1024.png` with a
    correct `Contents.json`) and `AccentColor.colorset` (any neutral, e.g. systemBlue
    default is fine).
- The app must compile warning-clean with `xcodebuild -project ios/HQ.xcodeproj -scheme
  HQ -destination 'generic/platform=iOS Simulator' -configuration Debug build
  CODE_SIGNING_ALLOWED=NO`. Generate the project with `cd ios && xcodegen generate`.
- Light + dark follow the system (`UIUserInterfaceStyle` unset).

## Deploy (deploy/) — already written by Jake's assistant, read before changing

- The PC copy at `~/hq` is a normal git clone with
  `receive.denyCurrentBranch = updateInstead`; the Mac repo has remote `pc`.
  `deploy/deploy.sh "msg"` commits everything and `git push pc HEAD:main`; the PC's
  `.git/hooks/post-update` restarts `hq.service` if `server/` or `deploy/` changed
  (web-only pushes need no restart — the server reads files from disk every request).
- `deploy/hq.service` runs `node server/index.js` with the nvm node path, `Restart=always`.
